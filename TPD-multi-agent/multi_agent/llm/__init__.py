"""LLM 适配：demo mock + live httpx。"""

from __future__ import annotations

from typing import Any, Optional

import httpx

from multi_agent.config import Settings
from multi_agent.utils.errors import ExecFailError
from multi_agent.utils.logger import get_logger

logger = get_logger()


class LLMClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def complete(self, prompt: str, *, role: str = "assistant", system: str = "") -> str:
        if self.settings.mock_mode:
            return self._demo_complete(prompt, role=role, system=system)
        return self._live_complete(prompt, system=system)

    def _demo_complete(self, prompt: str, *, role: str, system: str) -> str:
        snippet = prompt.strip().replace("\n", " ")[:120]
        return (
            f"[demo:{role}] 基于输入「{snippet}…」的结论。"
            f" system={bool(system)} mock=true"
        )

    def _live_complete(self, prompt: str, *, system: str) -> str:
        if not self.settings.api_key:
            raise ExecFailError("live 模式需要 MULTI_AGENT_API_KEY 或 config 中 api_key")
        base = (self.settings.api_base or "https://api.openai.com/v1").rstrip("/")
        url = f"{base}/chat/completions"
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        payload: dict[str, Any] = {
            "model": self.settings.model,
            "messages": messages,
            "temperature": 0.4,
        }
        headers = {
            "Authorization": f"Bearer {self.settings.api_key}",
            "Content-Type": "application/json",
        }
        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"]
        except Exception as exc:  # noqa: BLE001
            logger.error("LLM 调用失败: %s", exc)
            raise ExecFailError(f"LLM 调用失败: {exc}") from exc
