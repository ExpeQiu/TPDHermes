"""V04 技术卡工作区。Hermes 只选择动作，卡片内容由这里的目录写入。"""

from __future__ import annotations

import json
import logging
import os
import re
from copy import deepcopy
from typing import Any

import httpx

logger = logging.getLogger("tpdx.hermes.studio")

SOURCE_TEXT = "\n".join(
    [
        "800V 高压平台将直流母线电压提升至 800 伏，用于降低线束电流。样本未给出持续功率。",
        "碳化硅功率模块用 SiC MOSFET 替换硅基器件，开关频率更高。文中未写适用车型。",
        "SiC 逆变器与碳化硅功率模块描述同一动力域部件，开关动作相同。",
        "座舱氛围灯属于座舱域，调节内饰颜色，与电驱参数无共同定义。",
    ]
)

FIELD_LABEL = {
    "definition": "定义",
    "principle": "原理",
    "parameter": "参数",
    "scope": "适用范围",
}
OPERATIONS = {"extract", "lock", "merge", "merge-cross", "locate", "gaps", "help"}
MERGE_TERMS = {"碳化硅功率模块", "SiC 逆变器"}

CATALOG: list[dict[str, Any]] = [
    {
        "term": "800V 高压平台",
        "aliases": ["800V"],
        "domain": "动力",
        "definition": "将直流母线电压提升至 800 伏",
        "principle": "降低线束电流",
        "parameter": "800 伏",
        "scope": "",
        "quotes": {
            "definition": "800V 高压平台将直流母线电压提升至 800 伏",
            "principle": "用于降低线束电流",
            "parameter": "提升至 800 伏",
            "scope": "样本未给出持续功率",
        },
    },
    {
        "term": "碳化硅功率模块",
        "aliases": ["碳化硅"],
        "domain": "动力",
        "definition": "用 SiC MOSFET 替换硅基器件",
        "principle": "开关频率更高",
        "parameter": "",
        "scope": "",
        "quotes": {
            "definition": "碳化硅功率模块用 SiC MOSFET 替换硅基器件",
            "principle": "开关频率更高",
            "parameter": "",
            "scope": "文中未写适用车型",
        },
    },
    {
        "term": "SiC 逆变器",
        "aliases": ["逆变器"],
        "domain": "动力",
        "definition": "与碳化硅功率模块描述同一动力域部件",
        "principle": "开关动作相同",
        "parameter": "",
        "scope": "",
        "quotes": {
            "definition": "SiC 逆变器与碳化硅功率模块描述同一动力域部件",
            "principle": "开关动作相同",
            "parameter": "",
            "scope": "",
        },
    },
    {
        "term": "座舱氛围灯",
        "aliases": ["氛围灯", "座舱"],
        "domain": "座舱",
        "definition": "调节内饰颜色",
        "principle": "",
        "parameter": "",
        "scope": "座舱域",
        "quotes": {
            "definition": "调节内饰颜色",
            "principle": "",
            "parameter": "",
            "scope": "座舱氛围灯属于座舱域",
        },
    },
]

STUDIO_TOOL = {
    "type": "function",
    "function": {
        "name": "studio_apply",
        "description": "选择技术卡工作区的一个动作。不要编写卡片内容。",
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": sorted(OPERATIONS)},
                "term": {"type": "string", "description": "locate 时填写要定位的术语"},
            },
            "required": ["operation"],
            "additionalProperties": False,
        },
    },
}


class StudioUpstreamError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def create_state() -> dict[str, Any]:
    return {
        "revision": 0,
        "nextId": 1,
        "cards": [],
        "selectedCardId": None,
        "selectedField": None,
        "lastOperation": None,
        "lastRunId": None,
        "blockedReason": None,
    }


def resolve_driver() -> str:
    forced = os.getenv("STUDIO_EXECUTION_MODE", "").strip().lower()
    if forced in {"mock", "hermes"}:
        return forced
    if os.getenv("HERMES_CHAT_API_URL", "").strip():
        return "hermes"
    return "mock"


def parse_command(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return "help"
    if re.search(r"缺口|缺什么|空字段", raw):
        return "gaps"
    if "锁定" in raw:
        return "lock"
    if re.search(r"跨域|氛围灯|座舱", raw) and "合并" in raw:
        return "merge-cross"
    if "合并" in raw:
        return "merge"
    if re.search(r"定位|看看|查看", raw):
        return "locate"
    if re.search(r"提取|重新|再来", raw):
        return "extract"
    return "help"


def _locked_ids(cards: list[dict[str, Any]]) -> list[str]:
    return [card["id"] for card in cards if card.get("status") == "locked"]


def _finish(prev: dict[str, Any], nxt: dict[str, Any], operation: str, reply: str, ok: bool) -> dict[str, Any]:
    state = deepcopy(nxt)
    run_id = f"studio_{operation}_{state['revision']}"
    state["lastOperation"] = operation
    state["lastRunId"] = run_id
    return {
        "state": state,
        "reply": reply,
        "log": {
            "event": "studio.operation",
            "operation": operation,
            "run_id": run_id,
            "revision": state["revision"],
            "card_count": len(state["cards"]),
            "locked_ids": _locked_ids(state["cards"]),
            "ok": ok,
        },
    }


def _materialize(draft: dict[str, Any], card_id: str) -> dict[str, Any]:
    card = deepcopy(draft)
    card["id"] = card_id
    card["status"] = "candidate"
    return card


def _covers(locked: list[dict[str, Any]], draft: dict[str, Any]) -> bool:
    names = {name for card in locked for name in [card["term"], *card.get("aliases", [])]}
    return draft["term"] in names or any(alias in names for alias in draft.get("aliases", []))


def _extract(prev: dict[str, Any]) -> dict[str, Any]:
    locked = [card for card in prev["cards"] if card.get("status") == "locked"]
    next_id = int(prev["nextId"])
    fresh: list[dict[str, Any]] = []
    for draft in CATALOG:
        if _covers(locked, draft):
            continue
        fresh.append(_materialize(draft, f"card_{next_id}"))
        next_id += 1
    cards = [*locked, *fresh]
    selected = prev.get("selectedCardId")
    still = any(card["id"] == selected for card in cards)
    return _finish(
        prev,
        {
            "revision": int(prev["revision"]) + 1,
            "nextId": next_id,
            "cards": cards,
            "selectedCardId": selected if still else (cards[0]["id"] if cards else None),
            "selectedField": prev.get("selectedField") if still else "definition",
            "blockedReason": None,
        },
        "extract",
        f"已提取 {len(fresh)} 张候选。已锁定 {len(locked)} 张保持原内容。空字段保留为缺口，没有补写事实。",
        True,
    )


def _lock(prev: dict[str, Any]) -> dict[str, Any]:
    card = next((item for item in prev["cards"] if item["id"] == prev.get("selectedCardId")), None)
    if card is None:
        return _finish(prev, prev, "lock", "先在右侧点一张技术卡，再锁定。", False)
    if card.get("status") == "locked":
        return _finish(prev, prev, "lock", f"「{card['term']}」已经锁定。", True)
    cards = []
    for item in prev["cards"]:
        copied = deepcopy(item)
        if copied["id"] == card["id"]:
            copied["status"] = "locked"
        cards.append(copied)
    nxt = deepcopy(prev)
    nxt["revision"] = int(prev["revision"]) + 1
    nxt["cards"] = cards
    nxt["blockedReason"] = None
    return _finish(prev, nxt, "lock", f"已锁定「{card['term']}」。再次提取不会覆盖这张卡。", True)


def _same_domain_pair(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [card for card in cards if card.get("domain") == "动力" and card.get("term") in MERGE_TERMS]


def _merge(prev: dict[str, Any]) -> dict[str, Any]:
    pair = _same_domain_pair(prev["cards"])
    if len(pair) < 2:
        return _finish(prev, prev, "merge", "要合并的同域候选不足两张。先提取技术卡。", False)
    if any(card.get("status") == "locked" for card in pair):
        nxt = deepcopy(prev)
        nxt["blockedReason"] = "已锁定卡片不能被合并覆盖"
        return _finish(prev, nxt, "merge", "其中一张已锁定。合并会改写已确认内容，已停下。", False)
    primary, alias = pair[0], pair[1]
    next_id = int(prev["nextId"])
    merged = {
        "id": f"card_{next_id}",
        "term": primary["term"],
        "aliases": [alias["term"], *primary.get("aliases", []), *alias.get("aliases", [])],
        "domain": "动力",
        "definition": f"{primary['definition']}。同义写法：{alias['term']}",
        "principle": primary.get("principle") or alias.get("principle") or "",
        "parameter": primary.get("parameter") or "",
        "scope": "",
        "quotes": {
            "definition": primary["quotes"]["definition"],
            "principle": primary["quotes"].get("principle") or alias["quotes"].get("principle") or "",
            "parameter": primary["quotes"].get("parameter") or "",
            "scope": primary["quotes"].get("scope") or alias["quotes"].get("scope") or "",
        },
        "status": "candidate",
    }
    drop = {card["id"] for card in pair}
    cards = [merged, *[card for card in prev["cards"] if card["id"] not in drop]]
    return _finish(
        prev,
        {
            "revision": int(prev["revision"]) + 1,
            "nextId": next_id + 1,
            "cards": cards,
            "selectedCardId": merged["id"],
            "selectedField": "definition",
            "blockedReason": None,
            "lastOperation": prev.get("lastOperation"),
            "lastRunId": prev.get("lastRunId"),
        },
        "merge",
        f"已把「{alias['term']}」并入「{primary['term']}」。两处原文都还在，适用范围仍空着。",
        True,
    )


def _merge_cross(prev: dict[str, Any]) -> dict[str, Any]:
    nxt = deepcopy(prev)
    nxt["blockedReason"] = "跨域卡片不能合并"
    return _finish(prev, nxt, "merge", "座舱氛围灯与动力域技术点不是同一对象，没有合并。", False)


def _locate(prev: dict[str, Any], text: str) -> dict[str, Any]:
    card = next(
        (
            item
            for item in prev["cards"]
            if any(name and name in text for name in [item["term"], *item.get("aliases", [])])
        ),
        None,
    )
    if card is None:
        return _finish(prev, prev, "locate", "没有找到对应技术卡。先提取，或点右侧卡片。", False)
    nxt = deepcopy(prev)
    nxt["selectedCardId"] = card["id"]
    nxt["selectedField"] = "definition"
    nxt["blockedReason"] = None
    return _finish(prev, nxt, "locate", f"已定位「{card['term']}」，右侧原文标出定义出处。", True)


def _gaps(prev: dict[str, Any]) -> dict[str, Any]:
    lines = [
        f"「{card['term']}」的{FIELD_LABEL[field]}"
        for card in prev["cards"]
        for field in FIELD_LABEL
        if not str(card.get(field) or "").strip()
    ]
    if not lines:
        reply = "当前卡片没有空字段。" if prev["cards"] else "还没有技术卡。"
        return _finish(prev, prev, "gaps", reply, True)
    return _finish(prev, prev, "gaps", f"这些字段原文没有记载：{'、'.join(lines)}。", True)


def _help(prev: dict[str, Any]) -> dict[str, Any]:
    return _finish(
        prev,
        prev,
        "help",
        "可以说：提取技术卡、查看缺口、锁定、合并同域、合并氛围灯。点右侧字段会标出原文。",
        True,
    )


def apply_operation(state: dict[str, Any], operation: str, text: str = "") -> dict[str, Any]:
    prev = normalize_state(state)
    if operation == "extract":
        return _extract(prev)
    if operation == "lock":
        return _lock(prev)
    if operation == "merge":
        return _merge(prev)
    if operation == "merge-cross":
        return _merge_cross(prev)
    if operation == "locate":
        return _locate(prev, text)
    if operation == "gaps":
        return _gaps(prev)
    return _help(prev)


def normalize_state(raw: dict[str, Any] | None) -> dict[str, Any]:
    base = create_state()
    if not isinstance(raw, dict):
        return base
    cards = raw.get("cards") if isinstance(raw.get("cards"), list) else []
    clean_cards = []
    for item in cards:
        if not isinstance(item, dict) or not item.get("id") or not item.get("term"):
            continue
        quotes = item.get("quotes") if isinstance(item.get("quotes"), dict) else {}
        clean_cards.append(
            {
                "id": str(item["id"]),
                "term": str(item["term"]),
                "aliases": [str(alias) for alias in item.get("aliases") or []],
                "domain": str(item.get("domain") or ""),
                "definition": str(item.get("definition") or ""),
                "principle": str(item.get("principle") or ""),
                "parameter": str(item.get("parameter") or ""),
                "scope": str(item.get("scope") or ""),
                "quotes": {field: str(quotes.get(field) or "") for field in FIELD_LABEL},
                "status": "locked" if item.get("status") == "locked" else "candidate",
            }
        )
    field = raw.get("selectedField")
    base.update(
        {
            "revision": int(raw.get("revision") or 0),
            "nextId": int(raw.get("nextId") or 1),
            "cards": clean_cards,
            "selectedCardId": raw.get("selectedCardId"),
            "selectedField": field if field in FIELD_LABEL else None,
            "lastOperation": raw.get("lastOperation"),
            "lastRunId": raw.get("lastRunId"),
            "blockedReason": raw.get("blockedReason"),
        }
    )
    return base


def _state_digest(state: dict[str, Any]) -> str:
    if not state["cards"]:
        return "当前没有技术卡。"
    items = "、".join(f"{card['term']}（{card['status']}）" for card in state["cards"])
    selected = next((card["term"] for card in state["cards"] if card["id"] == state.get("selectedCardId")), "无")
    return f"当前卡片：{items}。当前选中：{selected}。"


def _parse_tool_call(payload: dict[str, Any]) -> tuple[str, str]:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise StudioUpstreamError("no_tool_call")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    tool_calls = message.get("tool_calls") if isinstance(message, dict) else None
    if not isinstance(tool_calls, list) or not tool_calls:
        raise StudioUpstreamError("no_tool_call")
    function = tool_calls[0].get("function") if isinstance(tool_calls[0], dict) else None
    if not isinstance(function, dict) or function.get("name") != "studio_apply":
        raise StudioUpstreamError("no_tool_call")
    arguments = function.get("arguments") or "{}"
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError as exc:
            raise StudioUpstreamError("invalid_tool_arguments") from exc
    if not isinstance(arguments, dict):
        raise StudioUpstreamError("invalid_tool_arguments")
    operation = str(arguments.get("operation") or "")
    if operation not in OPERATIONS:
        raise StudioUpstreamError("invalid_operation")
    return operation, str(arguments.get("term") or "")


async def fetch_hermes_operation(message: str, state: dict[str, Any]) -> tuple[str, str]:
    url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    if not url:
        raise StudioUpstreamError("upstream_unconfigured")
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "model": os.getenv("HERMES_CHAT_MODEL", "hermes-agent"),
        "stream": False,
        "temperature": 0,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是技术卡工作区调度器。必须调用 studio_apply 一次。"
                    "extract=提取或再提取；lock=锁定当前卡；merge=合并同域同义项；"
                    "merge-cross=跨域、氛围灯或座舱合并；locate=定位并填写 term；"
                    "gaps=查看缺口；help=其他。不要编写技术卡内容。"
                ),
            },
            {"role": "user", "content": f"{message}\n{_state_digest(state)}"},
        ],
        "tools": [STUDIO_TOOL],
        "tool_choice": {"type": "function", "function": {"name": "studio_apply"}},
    }
    timeout = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise StudioUpstreamError("upstream_unavailable") from exc
    if response.status_code >= 400:
        logger.warning(
            "studio hermes status=%s body=%s",
            response.status_code,
            response.text[:300],
        )
        raise StudioUpstreamError("upstream_error")
    try:
        body = response.json()
    except json.JSONDecodeError as exc:
        raise StudioUpstreamError("invalid_upstream") from exc
    return _parse_tool_call(body)


async def run_studio_turn(message: str, state: dict[str, Any] | None) -> dict[str, Any]:
    current = normalize_state(state)
    requested = resolve_driver()
    operation = ""
    term = ""
    fallback = None
    driver = "mock"
    if requested == "hermes":
        try:
            operation, term = await fetch_hermes_operation(message, current)
            driver = "hermes"
        except StudioUpstreamError as exc:
            fallback = exc.reason
            logger.warning("studio hermes fallback reason=%s", exc.reason)
    if driver != "hermes":
        operation = parse_command(message)
        term = ""
    locate_text = term or message
    applied = apply_operation(current, operation, locate_text if operation == "locate" else message)
    applied["driver"] = driver
    applied["fallback_reason"] = fallback
    applied["log"]["driver"] = driver
    logger.info(
        "studio turn driver=%s operation=%s run_id=%s revision=%s ok=%s fallback=%s",
        driver,
        applied["log"]["operation"],
        applied["log"]["run_id"],
        applied["log"]["revision"],
        applied["log"]["ok"],
        fallback or "",
    )
    return applied
