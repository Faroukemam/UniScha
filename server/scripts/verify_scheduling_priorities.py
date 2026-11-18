"""Isolated regression tests for editable preferences and protected allocations."""
import copy
import unittest

import auto_schedule as scheduler
from verify_invigilation_optimizer import payload, person, session, assert_invariants


class SchedulingPriorityTests(unittest.TestCase):
    def fixture(self, daily_first=False):
        data = payload([
            session("A_FIRST", "09:00", "10:00"), session("A_LATE", "11:00", "12:00"),
            session("A_LAST", "09:00", "10:00", "2026-11-03"),
            session("B_FIRST", "09:00", "10:00"), session("B_MIDDLE", "10:00", "11:00"),
            session("B_DAY2", "09:00", "10:00", "2026-11-02"),
        ], [dict(person("A"), prefer_consecutive_days=True, prefer_consecutive_duties=True), person("B")])
        data["options"].update(preference_order=list(scheduler.DEFAULT_PREFERENCE_ORDER), daily_penalty_weight=5)
        if daily_first:
            data["options"]["preference_order"] = ["daily_soft_target", "engagement_overrides", "consecutive_days", "consecutive_duties"]
        data["locked_assignments"] = [dict(staff_id=staff, session_id=duty, role="TA") for staff, duty in [("A", "A_FIRST"), ("A", "A_LAST"), ("B", "B_FIRST")]]
        return data

    def refine(self, data):
        sessions, staff, engagements, locked, policies, existing, additional, options = scheduler.validate_and_normalize(data)
        summary = scheduler.compute_hour_policy_summary(sessions, staff, policies, additional)
        locked_keys = {(row["staff_id"], row["session_id"]) for row in locked}
        assignments = [dict(staff_id=staff_id, session_id=duty, role="TA", locked=(staff_id, duty) in locked_keys)
                       for staff_id, duty in [("A", "A_FIRST"), ("A", "A_LATE"), ("A", "A_LAST"), ("B", "B_FIRST"), ("B", "B_MIDDLE"), ("B", "B_DAY2")]]
        result = scheduler.build_result_payload("FIXTURE", sessions, staff, assignments, [], {"A": 180, "B": 180}, summary)
        scheduler.refine_preference_exchanges(result, sessions, staff, engagements, locked, policies, existing, additional, options)
        scheduler.add_continuity_metrics(result, sessions, staff, options)
        scheduler.add_daily_workload_metrics(result, sessions, options)
        scheduler.add_workload_balance_metrics(result, sessions, staff, options)
        assert_invariants(data, result)
        return result

    def test_consecutive_days_can_outweigh_daily_soft_target_without_changing_hours(self):
        result = self.refine(self.fixture())
        self.assertEqual(result["continuityDayGaps"], 0)
        self.assertEqual(result["continuityIdleMinutes"], 0)
        self.assertEqual(result["dailyPenalty"], 5)
        self.assertEqual(result["assignedHoursByStaff"], {"A": 3, "B": 3})
        self.assertEqual(result["sessionHoursByStaff"], {"A": 3, "B": 3})
        self.assertEqual(result["onCallHoursByStaff"], {"A": 0, "B": 0})

    def test_daily_first_order_produces_different_behavior(self):
        result = self.refine(self.fixture(True))
        self.assertEqual(result["continuityDayGaps"], 1)
        self.assertEqual(result["dailyPenalty"], 0)
        self.assertEqual(result["continuityIdleMinutes"], 0)

    def test_engagement_opt_out_stays_hard(self):
        data = self.fixture()
        data["engagements"] = [dict(staff_id="A", date="2026-11-02", startTime="09:00", endTime="10:00")]
        self.assertEqual(self.refine(data)["continuityDayGaps"], 1)

    def test_session_and_on_call_hours_cannot_be_exchanged_to_close_gap(self):
        data = self.fixture()
        data["sessions"][-1]["duty_type"] = "on_call"
        self.assertEqual(self.refine(data)["continuityDayGaps"], 1)

    def test_result_selection_uses_the_configured_order(self):
        compact = {"continuityDayGaps": 0, "dailyPenalty": 5}
        spread = {"continuityDayGaps": 1, "dailyPenalty": 0}
        self.assertEqual(scheduler.compare_result_metrics(compact, spread)[0], "cp_sat")
        self.assertEqual(scheduler.compare_result_metrics(compact, spread, ["daily_soft_target", "engagement_overrides", "consecutive_days", "consecutive_duties"])[0], "fallback")

    def test_weighted_points_change_the_tradeoff(self):
        data = self.fixture()
        data["options"].update(scoring_mode="weighted", preference_weights=dict(scheduler.DEFAULT_PREFERENCE_WEIGHTS))
        self.assertEqual(self.refine(data)["continuityDayGaps"], 0)
        data["options"]["preference_weights"]["daily_soft_target"] = 1000
        result = self.refine(data)
        self.assertEqual(result["continuityDayGaps"], 1)
        self.assertEqual(result["dailyPenalty"], 0)

    def test_points_use_consistent_units(self):
        options = {"preference_weights": dict(scheduler.DEFAULT_PREFERENCE_WEIGHTS), "daily_penalty_weight": 5}
        values = dict(engagement_overrides=60, consecutive_days=1, consecutive_duties=60, daily_soft_target=5)
        self.assertEqual(scheduler.weighted_preference_cost(values, options) / 60, 161)

    def test_invalid_weights_are_rejected(self):
        for weights in [{}, dict.fromkeys(scheduler.DEFAULT_PREFERENCE_ORDER, 0), dict(scheduler.DEFAULT_PREFERENCE_WEIGHTS, consecutive_days=-1)]:
            data = self.fixture()
            data["options"].update(scoring_mode="weighted", preference_weights=weights)
            with self.assertRaises(ValueError):
                scheduler.validate_and_normalize(data)

    def test_invalid_priority_orders_are_rejected(self):
        for order in [[], ["consecutive_days"] * 4, list(scheduler.DEFAULT_PREFERENCE_ORDER) + ["unknown"]]:
            data = self.fixture()
            data["options"]["preference_order"] = order
            with self.assertRaises(ValueError):
                scheduler.solve(copy.deepcopy(data))


if __name__ == "__main__":
    unittest.main(verbosity=2)
