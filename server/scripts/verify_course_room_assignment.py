"""Run with: python server/scripts/verify_course_room_assignment.py"""
import unittest
from collections import defaultdict
from unittest.mock import patch

import auto_room_assignment as assignment


class ResultEmitted(Exception):
    def __init__(self, result):
        self.result = result


def course(code, students, start="09:00", end="10:00", kind="TH", date="2026-11-06"):
    return dict(courseCode=code, students=students, date=date, start=start, end=end, roomPlacementType=kind)


def room(name="R1", major=30, minor=40, kind="TH", backup=True):
    return dict(room=name, majorCap=major, minorCap=minor, roomType=kind, autoAvailable=backup)


def solve(courses, rooms, availability=None, locked=None, **settings):
    courses = [dict(row, rowNumber=index + 2) for index, row in enumerate(courses)]
    payload = dict(courses=courses, capacities=rooms, availability=availability or [],
                   settings=dict(timeLimitSeconds=3, **settings))
    if locked:
        payload["lockedAssignments"] = locked
    def capture(result):
        raise ResultEmitted(result)

    with patch.object(assignment, "emit", side_effect=capture):
        try:
            assignment.solve(payload)
        except ResultEmitted as emitted:
            result = emitted.result
    if result["status"] not in {"OPTIMAL", "FEASIBLE"}:
        raise AssertionError(result)
    assert_invariants(result, rooms)
    return result


def assert_invariants(result, rooms):
    capacities = {row["room"]: row for row in rooms}
    group_types = {row["placementGroupId"]: row["roomPlacementType"] for row in result["results"]}
    by_group = defaultdict(list)
    by_room = defaultdict(list)
    for row in result["roomRows"]:
        by_group[row["placementGroupId"]].append(row)
        by_room[(row["room"], row["date"])].append(row)
        assert row["studentsAssignedToThisRoom"] > 0
    for group in result["results"]:
        rows = by_group[group["placementGroupId"]]
        assert sum(row["studentsAssignedToThisRoom"] for row in rows) + group["shortage"] == group["totalStudents"]
        assert len({row["room"] for row in rows}) == len(rows), "A group used both blocks in one room"
    for (name, _date), rows in by_room.items():
        for checkpoint in {row["start"] for row in rows}:
            active = [row for row in rows if row["start"] <= checkpoint < row["end"]]
            assert len({(row["start"], row["end"]) for row in active}) <= 1, "Conflicting room windows"
            for mode, field in (("Major", "majorCap"), ("Minor", "minorCap")):
                used = sum(row["studentsAssignedToThisRoom"] for row in active if row["capacityMode"] == mode)
                non_dh = sum(row["studentsAssignedToThisRoom"] for row in active
                             if row["capacityMode"] == mode and group_types[row["placementGroupId"]] != "DH")
                assert used <= capacities[name][field] + min(assignment.overflow_extra(capacities[name][field]), non_dh)


class CourseRoomAssignmentTests(unittest.TestCase):
    def test_one_block_per_group_per_room(self):
        result = solve([course("A", 60)], [room()])
        self.assertEqual(result["results"][0]["shortage"], 16)

    def test_different_groups_can_use_both_blocks(self):
        result = solve([course("A", 40), course("B", 30)], [room()])
        self.assertEqual(sum(row["shortage"] for row in result["results"]), 0)
        self.assertEqual({row["capacityMode"] for row in result["roomRows"]}, {"Major", "Minor"})

    def test_availability_can_cover_a_shorter_exam(self):
        sessions = [dict(room="R1", date="2026-11-06", start="08:00", end="12:00")]
        result = solve([course("A", 20)], [room(backup=False)], sessions)
        self.assertEqual(result["results"][0]["shortage"], 0)
        self.assertEqual(result["results"][0]["status"], "Assigned")

    def test_availability_must_cover_the_whole_exam(self):
        sessions = [dict(room="R1", date="2026-11-06", start="09:00", end="09:30")]
        result = solve([course("A", 20)], [room(backup=False)], sessions)
        self.assertEqual(result["results"][0]["shortage"], 20)

    def test_overlapping_different_windows_cannot_share_room(self):
        result = solve([course("A", 20), course("B", 20, "09:30", "10:30")], [room(minor=50, major=0)])
        self.assertEqual(sum(row["shortage"] for row in result["results"]), 20)

    def test_back_to_back_and_different_dates_reuse_rooms(self):
        courses = [course("A", 40), course("B", 40, "10:00", "11:00"),
                   course("C", 40, date="2026-11-07")]
        result = solve(courses, [room()])
        self.assertEqual(result["summary"]["totalCourses"], 3)
        self.assertEqual(result["summary"]["totalPlacementGroups"], 3)
        self.assertEqual(len({row["placementGroupId"] for row in result["results"]}), 3)
        self.assertEqual(sum(row["shortage"] for row in result["results"]), 0)

    def test_shared_block_capacity_is_not_duplicated(self):
        result = solve([course("A", 30), course("B", 30)], [room(major=0, minor=50)])
        self.assertEqual(sum(row["shortage"] for row in result["results"]), 5)

    def test_dh_does_not_use_overflow(self):
        result = solve([course("A", 55, kind="DH")], [room(kind="DH", major=0, minor=50)])
        self.assertEqual(result["results"][0]["shortage"], 5)

    def test_th_fallback_setting_is_respected(self):
        result = solve([course("A", 20)], [room(kind="LAB")], allowThFallback=False)
        self.assertEqual(result["results"][0]["shortage"], 20)

    def test_capacity_strategy_and_backup_setting_are_respected(self):
        result = solve([course("A", 40)], [room()], capacityStrategy="major")
        self.assertEqual(result["results"][0]["shortage"], 7)
        result = solve([course("A", 40)], [room()], useAutoAvailableBackup=False)
        self.assertEqual(result["results"][0]["shortage"], 40)

    def test_linked_groups_keep_their_identity_across_components(self):
        a = dict(course("A", 20), linkedGroup="LINK")
        b = dict(course("B", 20), linkedGroup="LINK")
        result = solve([a, b, course("C", 20, "10:00", "11:00")], [room()])
        self.assertEqual(result["summary"]["totalCourses"], 3)
        self.assertEqual(result["summary"]["totalPlacementGroups"], 2)
        linked = next(row for row in result["results"] if row["linkedGroup"] == "LINK")
        self.assertEqual(linked["totalStudents"], 40)
        self.assertEqual(linked["shortage"], 0)

    def test_empty_input(self):
        self.assertEqual(solve([], [room()])["results"], [])

    def test_backup_can_require_moving_a_normal_allocation(self):
        courses = [course("A", 30), course("B", 30, kind="LAB")]
        rooms = [room("LAB", major=0, minor=30, kind="LAB", backup=False),
                 room("TH", major=0, minor=30)]
        sessions = [dict(room="LAB", date="2026-11-06", start="09:00", end="10:00")]
        locked = [dict(placementGroupId="PG-1", room="LAB", capacityMode="Minor", students=20)]
        constrained = solve(courses, rooms, sessions, locked=locked)
        independent = solve(courses, rooms, sessions)
        self.assertGreater(sum(row["shortage"] for row in constrained["results"]), 0)
        self.assertEqual(sum(row["shortage"] for row in independent["results"]), 0)

    def test_timeout_keeps_the_valid_starting_layout(self):
        original_solve = assignment.cp_model.CpSolver.Solve

        def timeout_optimization(solver, model):
            if solver.parameters.num_search_workers == 4:
                return assignment.cp_model.UNKNOWN
            return original_solve(solver, model)

        with patch.object(assignment.cp_model.CpSolver, "Solve", timeout_optimization):
            result = solve([course("A", 40), course("B", 30)], [room()])
        self.assertEqual(result["status"], "FEASIBLE")
        self.assertEqual(sum(row["shortage"] for row in result["results"]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
