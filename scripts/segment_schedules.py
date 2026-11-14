"""Normalize the city's street-segment schedules without inferring enforcement."""
import re
from collections import Counter

WEEKDAYS = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')


def normalize_days(value):
    if not isinstance(value, str):
        return None
    days = {day.strip() for day in value.split(';')}
    if not days or days - set(WEEKDAYS):
        return None
    return [day for day in WEEKDAYS if day in days]


def normalize_time(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r'(1[0-2]|0?[1-9]):([0-5][0-9])\s*([AP]M)', value.strip(), re.I)
    if not match:
        return None
    hour, minute, period = match.groups()
    hour = int(hour) % 12 + (12 if period.upper() == 'PM' else 0)
    return f'{hour:02d}:{minute}'


def normalize_segment(row):
    days = normalize_days(row.get('Tow_Away_Days__c'))
    start = normalize_time(row.get('Tow_Away_Start_Time__c'))
    end = normalize_time(row.get('Tow_Away_End_Time__c'))
    signs_needed = row.get('Tow_Away_Signs_Needed__c')
    all_day = row.get('Tow_Away_24x7__c')
    status, issue = 'listed', None
    if signs_needed is False:
        status = 'no_tow_signs'
    elif signs_needed is not True or not days or not start or not end:
        status = 'unavailable'
    elif all_day is True:
        if days == list(WEEKDAYS) and start == '00:00' and end in ('00:00', '23:59'):
            status = 'all_day'
        else:
            status, issue = 'needs_verification', '24x7_conflict'
    elif start >= end:
        status = 'needs_verification'
        issue = 'same_time' if start == end else 'overnight_hours'

    return {
        'id': row['Id'],
        'block': row.get('Friendly_Name__c'),
        'side': row.get('Side_of_the_Street__c'),
        'tow_signs_needed': signs_needed,
        'weekdays': days,
        'start_time': start,
        'end_time': end,
        'city_24x7': all_day,
        'status': status,
        'issue': issue,
    }


def permit_schedule_status(segments):
    statuses = {segment['status'] for segment in segments}
    if 'needs_verification' in statuses:
        return 'needs_verification'
    if not statuses or 'unavailable' in statuses:
        return 'unavailable'
    if statuses == {'no_tow_signs'}:
        return 'no_tow_signs'
    return 'complete'


def coverage_by_type(permits):
    by_type = {}
    for permit in permits:
        by_type.setdefault(permit['type'], Counter())[permit_schedule_status(permit['tow_segments'])] += 1
    return by_type
