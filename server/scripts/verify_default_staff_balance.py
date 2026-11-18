"""Run: python server/scripts/verify_default_staff_balance.py (no saved data used)."""
import copy
import unittest
from unittest.mock import patch

import auto_schedule as scheduler
from verify_invigilation_optimizer import assert_invariants, payload, person, policy, session


class DefaultStaffBalanceTests(unittest.TestCase):
    def check_both(self, data, assertions):
        cp_model = scheduler.cp_model
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                with patch.object(scheduler, "cp_model", None if fallback else cp_model):
                    result = scheduler.solve(copy.deepcopy(data))
                assert_invariants(data, result)
                if cp_model is not None and not fallback:
                    self.assertNotIn(result["cpSatStatus"], ("MODEL_INVALID", "INFEASIBLE"))
                assertions(result)

    def mixed_fixture(self):
        return payload([session(f"E{i}", f"{9+i:02}:00", f"{10+i:02}:00", ta=2) for i in range(2)]
                       + [dict(session(f"R{i}", f"{9+i:02}:00", f"{10+i:02}:00", "2026-11-03", ta=2), duty_type="on_call") for i in range(2)],
                       [person(identifier) for identifier in ("A", "B", "C", "D")])

    def test_defaults_receive_both_duty_types_without_continuity_flags(self):
        data = self.mixed_fixture()
        data["staff_hour_policies"] = [policy("A", "default", 0)]
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(set(result["assignedHoursByStaff"].values()), {2})
            self.assertEqual(set(result["sessionHoursByStaff"].values()), {1})
            self.assertEqual(set(result["onCallHoursByStaff"].values()), {1})
            self.assertEqual(result["defaultDutyBalanceScore"], 0)
            self.assertEqual([row["staffCount"] for row in result["defaultStaffBalance"]], [4, 4])
        self.check_both(data, check)

    def test_exam_coverage_wins_over_more_reserve_assignments(self):
        data = payload([session("EXAM", "09:00", "11:00")]
                       + [dict(session(f"R{i}", f"{9+i:02}:00", f"{10+i:02}:00"), duty_type="on_call") for i in range(2)], [person("A")])
        def check(result):
            self.assertEqual([row["session_id"] for row in result["assignments"]], ["EXAM"])
            self.assertEqual(result["selectedMetrics"]["sessionShortage"], 0)
            self.assertEqual(result["selectedMetrics"]["onCallShortage"], 2)
        self.check_both(data, check)

    def test_custom_and_excluded_staff_are_not_equalized_with_defaults(self):
        data = self.mixed_fixture()
        data["invigilators"] += [person("LIMITED"), person("EXCLUDED")]
        data["staff_hour_policies"] = [policy("LIMITED", "exact", 1), policy("EXCLUDED", "exclude", 0)]
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertLessEqual(result["assignedHoursByStaff"].get("LIMITED", 0), 1)
            self.assertEqual(result["assignedHoursByStaff"].get("EXCLUDED", 0), 0)
            self.assertEqual([row["staffCount"] for row in result["defaultStaffBalance"]], [4, 4])
        self.check_both(data, check)

    def test_availability_and_total_load_take_priority_over_equal_duty_mix(self):
        data = payload([session(f"E{i}", f"{9+i:02}:00", f"{10+i:02}:00") for i in range(2)]
                       + [dict(session(f"R{i}", f"{9+i:02}:00", f"{10+i:02}:00", "2026-11-03"), duty_type="on_call") for i in range(2)],
                       [person("A"), person("B")],
                       engagements=[dict(staff_id="A", date="2026-11-03", startTime="09:00", endTime="11:00")])
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(result["onCallHoursByStaff"]["A"], 0)
            self.assertEqual(result["onCallHoursByStaff"]["B"], 2)
        self.check_both(data, check)

    def test_locked_duties_are_preserved_while_balancing(self):
        data = payload([session("EXAM", "09:00", "10:00"), dict(session("RESERVE", "10:00", "11:00"), duty_type="on_call")],
                       [person("A"), person("B")],
                       locked_assignments=[dict(staff_id="A", session_id="RESERVE", role="TA")])
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(result["onCallHoursByStaff"]["A"], 1)
            self.assertEqual(result["sessionHoursByStaff"]["B"], 1)
        self.check_both(data, check)

    def test_roles_have_separate_default_groups(self):
        data = self.mixed_fixture()
        for row in data["sessions"]:
            row["doctor_needed"] = 1
        data["invigilators"] += [person("DR1", "Doctor"), person("DR2", "Doctor")]
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            counts = {(row["role"], row["dutyType"]): row["staffCount"] for row in result["defaultStaffBalance"]}
            self.assertEqual(counts, {("TA", "session"): 4, ("TA", "on_call"): 4, ("Doctor", "session"): 2, ("Doctor", "on_call"): 2})
            self.assertEqual(result["sessionHoursByStaff"]["DR1"], 1)
            self.assertEqual(result["onCallHoursByStaff"]["DR2"], 1)
        self.check_both(data, check)

    def test_result_selection_keeps_coverage_before_default_balance(self):
        winner, _ = scheduler.compare_result_metrics(
            {"sessionShortage": 0, "onCallShortage": 2, "defaultDutyBalanceScore": 1000},
            {"sessionShortage": 1, "onCallShortage": 0, "defaultDutyBalanceScore": 0})
        self.assertEqual(winner, "cp_sat")
        winner, _ = scheduler.compare_result_metrics(
            {"defaultDutyBalanceScore": 0, "continuityIdleMinutes": 120},
            {"defaultDutyBalanceScore": 1000, "continuityIdleMinutes": 0})
        self.assertEqual(winner, "cp_sat")


if __name__ == "__main__":
    unittest.main(verbosity=2)
