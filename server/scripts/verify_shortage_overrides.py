"""Run: python server/scripts/verify_shortage_overrides.py (no saved data used)."""
from copy import deepcopy
import auto_schedule as scheduler


def fixture():
    return {
        'sessions': [
            {'id': 'exam', 'date': '2026-11-08', 'startTime': '17:00', 'endTime': '18:00', 'ta_needed': 1},
            {'id': 'reserve', 'date': '2026-11-08', 'startTime': '17:00', 'endTime': '18:00', 'ta_needed': 1, 'duty_type': 'on_call'},
        ],
        'invigilators': [{'staff_id': 'A', 'role': 'TA'}, {'staff_id': 'B', 'role': 'TA'}],
        'engagements': [{'staff_id': 'B', 'date': '2026-11-08', 'startTime': '17:00', 'endTime': '18:00'}],
        'options': {'time_limit_seconds': 2},
    }


def relaxed(payload):
    payload = deepcopy(payload)
    for person in payload['invigilators']:
        person['shortage_override'] = True
    for engagement in payload.get('engagements', []):
        engagement['allow_override'] = True
    return payload


for fallback in [False, True]:
    if fallback:
        scheduler.cp_model = None
    strict = scheduler.solve(fixture())
    assert strict['shortageRemaining'] == 1
    assert strict['assignments'][0]['session_id'] == 'exam'
    request = relaxed(fixture())
    result = scheduler.solve(request)
    assert result['shortageRemaining'] == 0
    assert len({row['staff_id'] for row in result['assignments']}) == 2, 'No overlapping duties'
    assert result['overridePenaltyMinutes'] == 60

    request['invigilators'].append({'staff_id': 'C', 'role': 'TA', 'shortage_override': True})
    preferred = scheduler.solve(request)
    assert preferred['shortageRemaining'] == 0
    assert preferred['overridePenaltyMinutes'] == 0, 'Use available staff before overrides'
    request['invigilators'][-1]['exclude_new_assignments'] = True
    protected = scheduler.solve(request)
    assert protected['shortageRemaining'] == 0
    assert not any(row['staff_id'] == 'C' for row in protected['assignments'])

    request = relaxed(fixture())
    request['invigilators'][1]['max_hours'] = 0.5
    assert scheduler.solve(request)['shortageRemaining'] == 1, 'Explicit maxHours remains strict'
    request['invigilators'][1]['max_hours'] = 0
    request['engagements'][0]['allow_override'] = False
    assert scheduler.solve(request)['shortageRemaining'] == 1, 'Fixed other duties remain strict'

    request = fixture()
    request['engagements'] = []
    request['staff_hour_policies'] = [{'staff_id': 'B', 'mode': 'exclude'}]
    assert scheduler.solve(request)['shortageRemaining'] == 1
    assert scheduler.solve(relaxed(request))['shortageRemaining'] == 0
    request['staff_hour_policies'] = [{'staff_id': 'B', 'mode': 'exact', 'hours_value': 0}]
    assert scheduler.solve(request)['shortageRemaining'] == 1
    assert scheduler.solve(relaxed(request))['shortageRemaining'] == 0

print('PASS: strict default, availability/exclusion/hour overrides, minimum exceptions, protected staff, exam priority, overlap protection and explicit maximums in CP-SAT and fallback.')
