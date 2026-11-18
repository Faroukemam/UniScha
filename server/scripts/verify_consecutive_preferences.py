"""Run: python server/scripts/verify_consecutive_preferences.py (no saved data used)."""
import copy
import unittest
from unittest.mock import patch

import auto_schedule as scheduler
from verify_invigilation_optimizer import assert_invariants, payload, person, policy, session


class ConsecutivePreferenceTests(unittest.TestCase):
    def check_both(self, data, assertions):
        cp_model = scheduler.cp_model
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                with patch.object(scheduler, "cp_model", None if fallback else cp_model):
                    result = scheduler.solve(copy.deepcopy(data))
                if not fallback and cp_model is not None:
                    self.assertNotIn(result["cpSatStatus"], ("MODEL_INVALID", "INFEASIBLE"))
                assert_invariants(data, result)
                assertions(result)

    def fixture(self, duties=False, days=False, across_days=False):
        sessions = [session("FIRST", "09:00", "10:00"), session("MIDDLE", "10:00", "11:00"), session("LAST", "11:00", "12:00")]
        if across_days:
            for index, row in enumerate(sessions, 1):
                row["date"] = f"2026-11-{index:02}"
        return payload(sessions, [person("A"), person("B")],
                       [dict(policy("A", "default", 0), prefer_consecutive_duties=duties, prefer_consecutive_days=days)],
                       locked_assignments=[dict(staff_id="A", session_id=identifier, role="TA") for identifier in ("FIRST", "LAST")])

    def assigned_to(self, result, session_id):
        return next(row["staff_id"] for row in result["assignments"] if row["session_id"] == session_id)

    def fair_bridge_fixture(self, **kwargs):
        data = self.fixture(**kwargs)
        for row in data["sessions"]:
            if row["id"] in ("FIRST", "LAST"):
                row["ta_needed"] = 2
                data["locked_assignments"].append(dict(staff_id="B", session_id=row["id"], role="TA"))
        return data

    def test_consecutive_duties_bridge_locks_within_a_fair_allocation(self):
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(self.assigned_to(result, "MIDDLE"), "A")
            self.assertEqual(result["continuityIdleMinutes"], 0)
        self.check_both(self.fair_bridge_fixture(duties=True), check)

    def test_consecutive_days_fill_the_calendar_gap(self):
        def check(result):
            self.assertEqual(self.assigned_to(result, "MIDDLE"), "A")
            self.assertEqual(result["continuityDayGaps"], 0)
        self.check_both(self.fair_bridge_fixture(days=True, across_days=True), check)

    def test_checkboxes_are_independent(self):
        for data in (self.fixture(days=True), self.fixture(duties=True, across_days=True)):
            self.check_both(data, lambda result: self.assertEqual(self.assigned_to(result, "MIDDLE"), "B"))

    def test_engagements_remain_strict_even_with_shortage_overrides(self):
        data = self.fixture(duties=True, days=True)
        data["engagements"] = [dict(staff_id="A", date="2026-11-01", startTime="10:00", endTime="11:00", allow_override=True)]
        data["invigilators"][0]["shortage_override"] = True
        def check(result):
            self.assertEqual(self.assigned_to(result, "MIDDLE"), "B")
            self.assertEqual(result["continuityIdleMinutes"], 60)
        self.check_both(data, check)

    def test_custom_hour_limits_and_explicit_maxima_remain_strict(self):
        for use_maximum in (False, True):
            data = self.fixture(duties=True, days=True)
            data["invigilators"][0]["shortage_override"] = True
            if use_maximum:
                data["invigilators"][0]["max_hours"] = 2
            else:
                data["staff_hour_policies"][0].update(mode="exact", hours_value=2)
            self.check_both(data, lambda result: self.assertEqual(self.assigned_to(result, "MIDDLE"), "B"))

    def test_exclusions_remain_strict(self):
        for preference in ("prefer_consecutive_duties", "prefer_consecutive_days"):
            data = payload([session("S")], [dict(person("A"), shortage_override=True), person("B")],
                           [dict(policy("A", "exclude", 0), **{preference: True})])
            self.check_both(data, lambda result: self.assertEqual(self.assigned_to(result, "S"), "B"))

    def test_on_call_exclusions_and_overlaps_remain_strict(self):
        data = payload([dict(session("RESERVE"), duty_type="on_call")],
                       [dict(person("A"), prefer_consecutive_duties=True, shortage_override=True, on_call_excluded=True), person("B")])
        self.check_both(data, lambda result: self.assertEqual(self.assigned_to(result, "RESERVE"), "B"))
        data["sessions"] = [session("EXAM", "09:30", "10:30")]
        data["fixed_duties"] = [dict(staff_id="A", date="2026-11-01", startTime="09:00", endTime="10:00")]
        data["existing_duty_minutes_by_staff"] = {"A": 60}
        self.check_both(data, lambda result: self.assertEqual(self.assigned_to(result, "EXAM"), "B"))

    def test_continuity_cannot_reduce_coverage(self):
        data = payload([session("FIRST", "09:00", "10:00"), session("LATE", "13:00", "14:00"),
                        session("NEXT", "09:00", "10:00", "2026-11-03")],
                       [dict(person("A"), prefer_consecutive_duties=True, prefer_consecutive_days=True)])
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(result["continuityDayGaps"], 1)
            self.assertEqual(result["continuityIdleMinutes"], 180)
        self.check_both(data, check)

    def test_fixed_duties_and_on_call_contribute_to_the_same_block(self):
        data = payload([session("EXAM", "10:00", "11:00"), dict(session("RESERVE", "11:00", "12:00"), duty_type="on_call")],
                       [dict(person("A", maximum=4), prefer_consecutive_duties=True), dict(person("B"), exclude_new_assignments=True)],
                       fixed_duties=[dict(staff_id="A", date="2026-11-01", startTime=start, endTime=end)
                                     for start, end in (("09:00", "10:00"), ("12:00", "13:00"))],
                       existing_duty_minutes_by_staff={"A": 120})
        def check(result):
            self.assertEqual({row["staff_id"] for row in result["assignments"]}, {"A"})
            self.assertEqual(result["continuityIdleMinutes"], 0)
            self.assertEqual(result["assignedHoursByStaff"]["A"], 4)
        self.check_both(data, check)

    def test_empty_single_and_overlapping_fixed_duties(self):
        for fixed in ([], [dict(staff_id="A", date="2026-11-01", startTime="09:00", endTime="11:00")],
                      [dict(staff_id="A", date="2026-11-01", startTime=start, endTime=end)
                       for start, end in (("09:00", "11:00"), ("10:00", "12:00"))]):
            data = payload([], [dict(person("A"), prefer_consecutive_days=True, prefer_consecutive_duties=True)], fixed_duties=fixed)
            self.check_both(data, lambda result: self.assertEqual((result["continuityDayGaps"], result["continuityIdleMinutes"]), (0, 0)))

    def test_calendar_gaps_cross_month_and_weekend_boundaries(self):
        self.assertEqual(scheduler.continuity_gaps([("2026-10-30", 540, 600), ("2026-11-02", 540, 600)]), (2, 0))

    def test_solver_selection_preserves_fairness_before_continuity(self):
        winner, _ = scheduler.compare_result_metrics(
            {"continuityDayGaps": 0, "continuityIdleMinutes": 0, "roleHourSpread": {"TA": 6}},
            {"continuityDayGaps": 1, "continuityIdleMinutes": 60, "roleHourSpread": {"TA": 0}})
        self.assertEqual(winner, "fallback")

    def reserve_gap_fixture(self):
        return payload([session("E1", "09:00", "10:00"), session("E2", "15:00", "16:00")]
                       + [dict(session(f"R{i}", f"{10+i:02}:00", f"{11+i:02}:00"), duty_type="on_call") for i in range(5)],
                       [dict(person("A"), prefer_consecutive_duties=True, prefer_consecutive_days=True)]
                       + [person(identifier) for identifier in ("B", "C", "D")],
                       locked_assignments=[dict(staff_id="A", session_id=identifier, role="TA") for identifier in ("E1", "E2")])

    def test_preferences_cannot_attract_extra_on_call_to_fill_idle_time(self):
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(result["onCallHoursByStaff"]["A"], 0)
            self.assertEqual(result["assignedHoursByStaff"]["A"], 2)
            self.assertLessEqual(max(result["assignedHoursByStaff"].values()), 2)
            self.assertLessEqual(max(result["onCallHoursByStaff"].values()), 2)
        self.check_both(self.reserve_gap_fixture(), check)

    def test_on_call_mix_is_balanced_before_compressing_working_days(self):
        data = payload([session(f"E{i}", f"{9+i:02}:00", f"{10+i:02}:00", ta=2) for i in range(2)]
                       + [dict(session(f"R{i}", f"{9+i:02}:00", f"{10+i:02}:00", "2026-11-03", ta=2), duty_type="on_call") for i in range(2)],
                       [dict(person("A"), prefer_consecutive_duties=True, prefer_consecutive_days=True)]
                       + [person(identifier) for identifier in ("B", "C", "D")])
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(set(result["assignedHoursByStaff"].values()), {2})
            self.assertEqual(set(result["onCallHoursByStaff"].values()), {1})
        self.check_both(data, check)

    def test_fairness_does_not_create_shortage_when_only_one_person_can_cover(self):
        data = self.reserve_gap_fixture()
        for member in data["invigilators"][1:]:
            member["on_call_excluded"] = True
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(result["onCallHoursByStaff"]["A"], 5)
        self.check_both(data, check)

    def test_fixed_on_call_hours_count_toward_balancing(self):
        data = payload([dict(session(f"R{i}", f"{10+i:02}:00", f"{11+i:02}:00", "2026-11-02"), duty_type="on_call") for i in range(2)],
                       [dict(person("A"), prefer_consecutive_duties=True, prefer_consecutive_days=True), person("B")],
                       fixed_duties=[dict(staff_id="A", date="2026-11-01", startTime="09:00", endTime="11:00", duty_type="on_call")],
                       existing_duty_minutes_by_staff={"A": 120}, additional_required_minutes_by_role={"TA": 120})
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(result["onCallHoursByStaff"], {"A": 2, "B": 2})
            self.assertEqual({row["staff_id"] for row in result["assignments"]}, {"B"})
        self.check_both(data, check)

    def test_solver_selection_preserves_on_call_balance_before_continuity(self):
        winner, _ = scheduler.compare_result_metrics(
            {"roleOnCallHourSpread": {"TA": 6}, "continuityIdleMinutes": 0},
            {"roleOnCallHourSpread": {"TA": 1}, "continuityIdleMinutes": 300})
        self.assertEqual(winner, "fallback")


if __name__ == "__main__":
    unittest.main(verbosity=2)
