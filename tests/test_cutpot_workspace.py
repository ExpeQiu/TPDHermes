from backend.services.cutpot_workbench import workspace_id


def test_cutpot_workspace_without_project_uses_user():
    assert workspace_id(None, "u1") == "user:u1"
    assert workspace_id("  ", "u1") == "user:u1"
    assert workspace_id("", "") == "user:default"


def test_cutpot_workspace_keeps_bound_project():
    assert workspace_id("p1", "u1") == "p1"
