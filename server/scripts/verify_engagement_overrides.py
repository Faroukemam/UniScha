"""Run: python server/scripts/verify_engagement_overrides.py (isolated fixtures)."""
import copy
import unittest
from unittest.mock import patch

import auto_schedule as scheduler
from verify_invigilation_optimizer import payload, person, policy, session


class EngagementOverrideTests(unittest.TestCase):
    def fixture(self, enabled=True):
        return payload([session("EXAM", "09:00", "10:00")],
                       [dict(person("A"), allow_engagement_override=enabled)],
                       engagements=[dict(staff_id="A", date="2026-11-01", startTime="09:00", endTime="10:00")])

    def both(self, data, check):
        engine = scheduler.cp_model
        for fallback in (False, True):
            with self.subTest(fallback=fallback), patch.object(scheduler, "cp_model", None if fallback else engine):
                check(scheduler.solve(copy.deepcopy(data)))

    def test_enabled_covers_shortage_and_reports_overlap(self):
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(result["engagementOverrideMinutes"], 60)
            self.assertEqual(result["engagementOverrides"][0]["staffId"], "A")
            self.assertTrue(result["engagementOverrides"][0]["reason"].startswith("Cover exam shortage"))
            self.assertEqual(result["policyViolations"], [])
        self.both(self.fixture(), check)

    def test_disabled_keeps_engagement_strict(self):
        self.both(self.fixture(False), lambda r: self.assertEqual(r["shortageRemaining"], 1))

    def test_overlap_minutes_are_clipped_and_not_duplicated(self):
        data = self.fixture()
        data["engagements"] = [dict(staff_id="A", date="2026-11-01", startTime=start, endTime=end)
                               for start, end in [("08:00", "09:30"), ("09:15", "09:45")]]
        self.both(data, lambda r: self.assertEqual(r["engagementOverrideMinutes"], 45))

    def test_other_policies_remain_strict_even_in_shortage_mode(self):
        for setting in (dict(mode="exact", hours_value=0), dict(mode="exclude"), dict(mode="reduce", hours_value=10)):
            data = self.fixture()
            data["invigilators"][0]["shortage_override"] = True
            data["staff_hour_policies"] = [dict(staff_id="A", **setting)]
            self.both(data, lambda r: self.assertEqual(r["shortageRemaining"], 1))
        data = self.fixture()
        data["invigilators"][0]["max_hours"] = 0.5
        self.both(data, lambda r: self.assertEqual(r["shortageRemaining"], 1))

    def test_fixed_other_duties_and_generated_busy_times_are_hard(self):
        data = self.fixture()
        data["fixed_duties"] = [dict(staff_id="A", date="2026-11-01", startTime="09:00", endTime="10:00", duty_type="control")]
        self.both(data, lambda r: self.assertEqual(r["shortageRemaining"], 1))
        data.pop("fixed_duties")
        data["engagements"][0].update(hard_conflict=True, allow_override=True)
        self.both(data, lambda r: self.assertEqual(r["shortageRemaining"], 1))

    def test_consecutive_preferences_work_with_explicit_permission(self):
        data = self.fixture()
        data["staff_hour_policies"] = [dict(policy("A", "exact", 1), prefer_consecutive_duties=True, prefer_consecutive_days=True,
                                            allow_engagement_override=True)]
        self.both(data, lambda r: self.assertEqual(r["shortageRemaining"], 0))

    def test_on_call_exclusions_remain_strict(self):
        data = self.fixture()
        data["sessions"][0]["duty_type"] = "on_call"
        data["invigilators"][0].update(on_call_excluded=True, shortage_override=True)
        self.both(data, lambda r: self.assertEqual(r["shortageRemaining"], 1))

    def test_existing_locks_are_reported_as_preserved(self):
        data = self.fixture()
        data["locked_assignments"] = [dict(staff_id="A", session_id="EXAM", role="TA")]
        self.both(data, lambda r: self.assertTrue(r["engagementOverrides"][0]["reason"].startswith("Preserved fixed or locked")))

    def test_never_assigns_overlapping_duties_and_exams_still_come_first(self):
        data = self.fixture()
        data["sessions"].append(dict(session("RESERVE", "09:00", "10:00"), duty_type="on_call"))
        def check(result):
            self.assertEqual([r["session_id"] for r in result["assignments"]], ["EXAM"])
        self.both(data, check)

    def test_engagement_can_be_overridden_to_improve_balance_without_shortage(self):
        data = self.fixture()
        data["invigilators"].append(person("B"))
        data["sessions"].append(session("LOCK", "10:00", "12:00"))
        data["locked_assignments"] = [dict(staff_id="B", session_id="LOCK", role="TA")]
        def check(result):
            self.assertEqual(result["shortageRemaining"], 0)
            self.assertEqual(next(r["staff_id"] for r in result["assignments"] if r["session_id"] == "EXAM"), "A")
            self.assertTrue(result["engagementOverrides"][0]["reason"].startswith("Workload balancing"))
        self.both(data, check)

    def test_equal_workload_prefers_no_engagement_override(self):
        data = self.fixture()
        data["invigilators"].append(person("B"))
        self.both(data, lambda r: self.assertEqual(r["engagementOverrideMinutes"], 0))

    @unittest.skipIf(scheduler.cp_model is None, "OR-Tools is unavailable")
    def test_balancing_and_override_stages_remain_visible_with_preferences(self):
        data = self.fixture()
        # This checks every optimization stage, not the one-second fallback.
        # Allow startup/presolve headroom when the machine is running a build.
        data["options"]["time_limit_seconds"] = 10
        data["invigilators"][0].update(prefer_consecutive_duties=True, prefer_consecutive_days=True)
        data["invigilators"].append(person("B"))
        data["sessions"].append(dict(session("RESERVE", "10:00", "11:00"), duty_type="on_call"))
        result = scheduler.solve(data)
        self.assertEqual(result["shortageRemaining"], 0)
        self.assertEqual([row["stage"] for row in result["optimizationStages"]],
                         ["coverage", "workload_balance", "default_duty_balance", "on_call_balance", "engagement_overrides", "consecutive_days", "consecutive_duties", "daily_soft_target"])
        self.assertTrue(all(row["status"] == "OPTIMAL" for row in result["optimizationStages"]))


if __name__ == "__main__":
    unittest.main()
