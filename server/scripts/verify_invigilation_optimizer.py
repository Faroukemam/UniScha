"""Run: python server/scripts/verify_invigilation_optimizer.py"""
import copy
import unittest
from collections import defaultdict
from unittest.mock import patch

import auto_schedule as scheduler


def session(identifier, start="09:00", end="11:00", date="2026-11-01", ta=1, doctor=0):
    return dict(id=identifier, date=date, start_time=start, end_time=end, ta_needed=ta, doctor_needed=doctor)


def person(identifier, role="TA", maximum=0):
    return dict(staff_id=identifier, role=role, max_hours=maximum)


def policy(identifier, mode, hours):
    return dict(staff_id=identifier, mode=mode, hours_value=hours)


def payload(sessions, people, policies=None, **extra):
    return dict(sessions=sessions, invigilators=people, staff_hour_policies=policies or [],
                options=dict(time_limit_seconds=1, variance_weight=20), **extra)


def assert_invariants(data, result):
    sessions, staff, engagements, locked, policies, existing, additional, _ = scheduler.validate_and_normalize(data)
    summary = scheduler.compute_hour_policy_summary(sessions, staff, policies, additional)
    by_session = {row["id"]: row for row in sessions}
    by_staff = {row["staff_id"]: row for row in staff}
    duties = defaultdict(list)
    assigned_minutes = defaultdict(int, existing)
    seen = set()
    for row in result["assignments"]:
        key = (row["staff_id"], row["session_id"])
        assert key not in seen, "Duplicate assignment"
        seen.add(key)
        duty = by_session[row["session_id"]]
        assert row["role"] == by_staff[row["staff_id"]]["role"]
        assert not summary["effective_policy_by_staff"][row["staff_id"]]["excluded"]
        duties[row["staff_id"]].append(duty)
        assigned_minutes[row["staff_id"]] += duty["duration_minutes"]
        for engagement in engagements:
            if engagement["staff_id"] == row["staff_id"] and engagement["exam_date"] == duty["exam_date"]:
                assert not scheduler.ranges_overlap(duty["start_minutes"], duty["end_minutes"], engagement["start_minutes"], engagement["end_minutes"])
    for identifier, rows in duties.items():
        for index, left in enumerate(rows):
            for right in rows[index + 1:]:
                assert left["exam_date"] != right["exam_date"] or not scheduler.ranges_overlap(
                    left["start_minutes"], left["end_minutes"], right["start_minutes"], right["end_minutes"])
    for identifier, effective in summary["effective_policy_by_staff"].items():
        if effective["has_hard_limit"]:
            assert assigned_minutes[identifier] <= effective["hard_limit_minutes"], (identifier, assigned_minutes[identifier], effective)
    keys = {(row["staff_id"], row["session_id"], row["role"]) for row in result["assignments"]}
    assert all((row["staff_id"], row["session_id"], row["role"]) in keys for row in locked)
    assert result["policyViolations"] == []


class InvigilationOptimizerTests(unittest.TestCase):
    def check(self, data):
        result = scheduler.solve(copy.deepcopy(data))
        assert_invariants(data, result)
        return result

    def test_exact_limit_and_flexible_default_cover_every_duty(self):
        data = payload([session("A"), session("B", "12:00", "16:00")],
                       [person("LIMIT"), person("DEFAULT")], [policy("LIMIT", "exact", 2)])
        result = self.check(data)
        self.assertEqual(result["shortageRemaining"], 0)
        self.assertLessEqual(result["assignedHoursByStaff"].get("LIMIT", 0), 2)

    def test_exact_zero_is_a_zero_cap(self):
        result = self.check(payload([session("A")], [person("A", maximum=12)], [policy("A", "exact", 0)]))
        self.assertEqual(result["shortageRemaining"], 1)

    def test_reduce_to_zero_is_a_zero_cap(self):
        result = self.check(payload([session("A")], [person("A")], [policy("A", "reduce", 20)]))
        self.assertEqual(result["shortageRemaining"], 1)

    def test_add_limit_and_maximum_are_both_hard(self):
        data = payload([session("A"), session("B", "12:00", "16:00")],
                       [person("A", maximum=3)], [policy("A", "add", 2)])
        result = self.check(data)
        self.assertLessEqual(result["assignedHoursByStaff"].get("A", 0), 3)
        self.assertEqual(result["shortageRemaining"], 1)

    def test_fallback_also_enforces_custom_limits(self):
        data = payload([session("A"), session("B", "12:00", "16:00")], [person("A")], [policy("A", "exact", 4)])
        with patch.object(scheduler, "cp_model", None):
            result = self.check(data)
        self.assertLessEqual(result["assignedHoursByStaff"].get("A", 0), 4)
        self.assertEqual(result["shortageRemaining"], 1)

    def test_existing_other_duties_consume_the_limit(self):
        result = self.check(payload([session("A")], [person("A")], [policy("A", "exact", 3)],
                                   existing_duty_minutes_by_staff={"A": 120}))
        self.assertEqual(result["shortageRemaining"], 1)

    def test_locked_policy_conflict_is_explained(self):
        data = payload([session("A")], [person("A")], [policy("A", "exact", 1)],
                       locked_assignments=[dict(staff_id="A", session_id="A", role="TA")])
        with self.assertRaises(scheduler.ScheduleConstraintError) as error:
            scheduler.solve(data)
        self.assertEqual(error.exception.details[0]["reason"], "fixed_duties_exceed_policy")

    def test_locked_time_conflict_is_rejected(self):
        data = payload([session("A"), session("B", "10:00", "12:00")], [person("A")],
                       locked_assignments=[dict(staff_id="A", session_id=identifier, role="TA") for identifier in ("A", "B")])
        with self.assertRaises(scheduler.ScheduleConstraintError):
            scheduler.solve(data)

    def test_valid_lock_stays_assigned(self):
        self.check(payload([session("A"), session("B", "11:00", "12:00")], [person("A"), person("B")],
                           locked_assignments=[dict(staff_id="A", session_id="A", role="TA")]))

    def test_nested_and_staggered_overlaps(self):
        data = payload([session("A", "09:00", "13:00"), session("B", "10:00", "11:00"),
                        session("C", "11:00", "12:00")], [person("A")])
        self.assertEqual(self.check(data)["shortageRemaining"], 1)

    def test_exclusion_and_role_separation(self):
        data = payload([session("A", doctor=1)], [person("TA"), person("EXCLUDED"), person("DR", "Doctor")],
                       [policy("EXCLUDED", "exclude", 0)])
        self.assertEqual(self.check(data)["shortageRemaining"], 0)

    def test_false_string_does_not_exclude_staff(self):
        data = payload([session("A")], [person("A")], [dict(policy("A", "exact", 2), exclude_from_auto_schedule="false")])
        self.assertEqual(self.check(data)["shortageRemaining"], 0)

    def test_fairness_weights_cannot_reduce_coverage(self):
        data = payload([session("A"), session("B", "12:00", "18:00")], [person("A"), person("B")])
        data["options"].update(variance_weight=1000000, spread_weight=1, coverage_weight=1)
        result = self.check(data)
        self.assertEqual(result["shortageRemaining"], 0)
        self.assertEqual(result["cpSatMetrics"]["totalShortage"], 0)

    def test_load_bounds_support_more_than_24_hours(self):
        data = payload([session(str(day), "08:00", "18:00", f"2026-11-{day:02}") for day in range(1, 5)],
                       [person("A", maximum=40)])
        self.assertEqual(self.check(data)["assignedHoursByStaff"]["A"], 40)

    def test_duplicate_staff_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate staff"):
            scheduler.solve(payload([session("A")], [person("A"), person("A")]))

    def test_daily_penalty_counts_locks_and_balances_days(self):
        data = payload([session(str(i), f"{9+i:02}:00", f"{10+i:02}:00") for i in range(3)]
                       + [session("NEXT", "09:00", "10:00", "2026-11-02")],
                       [person("A"), person("B")], [policy("A", "exact", 3), policy("B", "exact", 1)],
                       locked_assignments=[dict(staff_id="A", session_id=str(i), role="TA") for i in range(2)])
        data["options"].update(daily_penalty_weight=1000000, max_sessions_per_day_soft=2)
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                with patch.object(scheduler, "cp_model", None if fallback else scheduler.cp_model):
                    result = self.check(data)
                self.assertEqual(result["shortageRemaining"], 0)
                self.assertEqual(result["dailyExcessDuties"], 0)
                self.assertIn(dict(staff_id="B", session_id="2", role="TA"),
                              [{k: row[k] for k in ("staff_id", "session_id", "role")} for row in result["assignments"]])

    def test_daily_limit_is_soft_and_zero_options_are_respected(self):
        data = payload([session(str(i), f"{9+i:02}:00", f"{10+i:02}:00") for i in range(3)], [person("A")])
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                with patch.object(scheduler, "cp_model", None if fallback else scheduler.cp_model):
                    data["options"].update(daily_penalty_weight=1000000, max_sessions_per_day_soft=2)
                    result = self.check(data)
                    self.assertEqual(result["shortageRemaining"], 0)
                    self.assertEqual(result["dailyPenalty"], 1000000)
                    data["options"].update(daily_penalty_weight=0, max_sessions_per_day_soft=0)
                    result = self.check(data)
                    self.assertEqual(result["shortageRemaining"], 0)
                    self.assertEqual(result["dailyExcessDuties"], 3)
                    self.assertEqual(result["dailyPenalty"], 0)

    @unittest.skipIf(scheduler.cp_model is None, "OR-Tools is unavailable")
    def test_hour_balance_is_protected_from_daily_soft_target(self):
        # Equal total hours require three first-day duties for one person.
        # A daily preference must not override the protected hour balance.
        data = payload([session(str(i), f"{9+i:02}:00", f"{10+i:02}:00") for i in range(3)]
                       + [session("LONG", "09:00", "12:00", "2026-11-02")], [person("A"), person("B")])
        data["options"].update(daily_penalty_weight=10000000, max_sessions_per_day_soft=2)
        result, _ = scheduler.solve_with_cp_sat(*scheduler.validate_and_normalize(data))
        self.assertIsNotNone(result)
        assert_invariants(data, result)
        self.assertEqual(result["shortageRemaining"], 0)
        counts = defaultdict(int)
        for row in result["assignments"]:
            if row["session_id"] != "LONG":
                counts[row["staff_id"]] += 1
        self.assertEqual(max(counts.values()), 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
