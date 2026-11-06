from datetime import datetime
from zoneinfo import ZoneInfo

from backend.services.project_activity_service import activity_day, bucket_activity_days

SHANGHAI = ZoneInfo("Asia/Shanghai")


def test_naive_timestamp_stays_on_shanghai_calendar_day():
    assert activity_day("2026-05-12T23:40:00") == "2026-05-12"


def test_utc_evening_rolls_to_next_shanghai_day():
    assert activity_day("2026-11-06T16:30:00Z") == "2026-11-07"


def test_epoch_and_blank_are_dropped():
    now = datetime(2026, 11, 6, tzinfo=SHANGHAI)
    assert activity_day("1970-01-01T00:00:00Z", now=now) is None
    assert activity_day("  ", now=now) is None
    assert activity_day(None, now=now) is None


def test_bucket_merges_same_day():
    days = bucket_activity_days(
        [
            "2026-05-12T09:00:00",
            "2026-05-12T18:00:00",
            "2026-05-13T01:00:00",
            "not-a-date",
        ]
    )
    assert [(day.date, day.count) for day in days] == [
        ("2026-05-12", 2),
        ("2026-05-13", 1),
    ]
