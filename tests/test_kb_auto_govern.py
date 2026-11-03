from backend.services.kb_auto_govern import govern_reasons, plan_target


def test_missing_domain_and_folder_need_govern():
    reasons = govern_reasons("_uncategorized", "", {"structured_tech"})
    assert "missing_domain" in reasons
    assert "missing_folder" in reasons


def test_plan_moves_uncategorized_into_policy_domain():
    target = plan_target("_uncategorized", "", ["structured_tech"], "")
    assert target == ("structured_tech", "02-知识库")


def test_plan_keeps_complete_allowed_node():
    assert plan_target("structured_tech", "02-知识库/导入", ["structured_tech"], "") is None


def test_plan_rejects_domain_outside_policy():
    target = plan_target("public_intel", "01-汽车信息库", ["structured_tech"], "")
    assert target == ("structured_tech", "02-知识库")
