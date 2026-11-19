"""Availability is eligibility, not a minimum workload. Uses disposable fixtures."""
import copy
import unittest
from unittest.mock import patch

import auto_schedule as scheduler
from verify_invigilation_optimizer import payload, person, policy, session


class OptionalAvailabilityTests(unittest.TestCase):
    def check_engines(self, data, check):
        data = copy.deepcopy(data)
        data["options"]["time_limit_seconds"] = 5
        with self.subTest(engine="fallback"), patch.object(scheduler, "cp_model", None):
            check(scheduler.solve(copy.deepcopy(data)))
        if scheduler.cp_model is not None:
            with self.subTest(engine="cp_sat"):
                normalized = scheduler.validate_and_normalize(copy.deepcopy(data))
                result, status = scheduler.solve_with_cp_sat(*normalized)
                self.assertIsNotNone(result, status)
                check(result)

    def test_spare_staff_can_have_no_duties_despite_high_caps(self):
        data = payload([session("EXAM", "09:00", "10:00")],
                       [person(identifier, maximum=20) for identifier in ("A", "B", "C")],
                       [policy(identifier, "exact", 10) for identifier in ("A", "B", "C")])
        def check(result):
            self.assertEqual(len(result["assignments"]), 1)
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(sum(row["assigned_minutes"] == 0 for row in result["staff_loads"]), 2)
            self.assertEqual(result["policyViolations"], [])
        self.check_engines(data, check)

    def test_free_periods_with_no_demand_stay_unused(self):
        data = payload([session("EXAM", "09:00", "10:00"),
                        session("FREE", "10:00", "11:00", ta=0),
                        dict(session("RESERVE", "11:00", "12:00", ta=0), duty_type="on_call")],
                       [dict(person("A", maximum=12), prefer_consecutive_duties=True, prefer_consecutive_days=True)])
        def check(result):
            self.assertEqual([row["session_id"] for row in result["assignments"]], ["EXAM"])
            self.assertEqual(result["assignedHoursByStaff"]["A"], 1)
        self.check_engines(data, check)

    def test_continuity_does_not_require_a_filler_assignment(self):
        data = payload([session("FIRST", "09:00", "10:00"),
                        session("FREE", "10:00", "11:00", ta=0),
                        session("LAST", "11:00", "12:00")],
                       [dict(person("A"), prefer_consecutive_duties=True, prefer_consecutive_days=True)],
                       locked_assignments=[dict(staff_id="A", session_id=duty, role="TA") for duty in ("FIRST", "LAST")])
        self.check_engines(data, lambda result: self.assertEqual(
            {row["session_id"] for row in result["assignments"]}, {"FIRST", "LAST"}))

    def test_required_work_can_be_less_than_the_number_of_available_staff(self):
        data = payload([session("EXAM", "09:00", "10:00", ta=2)],
                       [person(identifier) for identifier in ("A", "B", "C", "D", "E")])
        def check(result):
            self.assertEqual(len(result["assignments"]), 2)
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(sum(row["assigned_minutes"] == 0 for row in result["staff_loads"]), 3)
        self.check_engines(data, check)

    def test_preserved_staff_fill_the_vacancy_without_extra_assignments(self):
        data = payload([session("EXAM", "09:00", "10:00")], [person(identifier) for identifier in ("A", "B", "C")],
                       locked_assignments=[dict(staff_id="A", session_id="EXAM", role="TA")])
        def check(result):
            self.assertEqual(len(result["assignments"]), 1)
            self.assertEqual(result["assignments"][0]["staff_id"], "A")
            self.assertTrue(result["assignments"][0]["locked"])
        self.check_engines(data, check)

    def test_existing_overstaffing_is_preserved_without_filling_more_free_time(self):
        data = payload([session("EXAM", "09:00", "10:00")], [person(identifier) for identifier in ("A", "B", "C")],
                       locked_assignments=[dict(staff_id=identifier, session_id="EXAM", role="TA") for identifier in ("A", "B")])
        self.check_engines(data, lambda result: self.assertEqual(
            {row["staff_id"] for row in result["assignments"]}, {"A", "B"}))

    def test_no_demand_does_not_create_work_to_reach_a_cap(self):
        data = payload([], [person("A", maximum=20)], [policy("A", "exact", 10)])
        def check(result):
            self.assertEqual(result["assignments"], [])
            self.assertEqual(result["assignedHoursByStaff"].get("A", 0), 0)
            self.assertEqual(result["policyViolations"], [])
        self.check_engines(data, check)

    def test_result_guard_rejects_filler_assignments(self):
        duties = [session("EXAM", ta=1), session("FREE", ta=0)]
        for assignments in [
            [dict(session_id="FREE", staff_id="A", role="TA", locked=False)],
            [dict(session_id="EXAM", staff_id=staff, role="TA", locked=False) for staff in ("A", "B")],
            [dict(session_id="EXAM", staff_id="A", role="TA", locked=True),
             dict(session_id="EXAM", staff_id="B", role="TA", locked=False)],
        ]:
            with self.subTest(assignments=assignments), self.assertRaises(scheduler.ScheduleConstraintError):
                scheduler.validate_demand_driven_assignments(duties, assignments)


if __name__ == "__main__":
    unittest.main(verbosity=2)
