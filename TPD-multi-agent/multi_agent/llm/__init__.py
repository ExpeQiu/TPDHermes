"""LLM 适配：demo mock + live httpx（OpenAI / Anthropic 兼容）。"""

from __future__ import annotations

from typing import Any

import httpx

from multi_agent.config import Settings
from multi_agent.utils.errors import ExecFailError
from multi_agent.utils.logger import get_logger

logger = get_logger()


def _is_anthropic_base(base: str) -> bool:
    b = base.lower().rstrip("/")
    return b.endswith("/anthropic") or "/anthropic" in b


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
        try:
            if _is_anthropic_base(base):
                return self._live_anthropic(base, prompt, system=system)
            return self._live_openai(base, prompt, system=system)
        except ExecFailError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("LLM 调用失败: %s", exc)
            raise ExecFailError(f"LLM 调用失败: {exc}") from exc

    def _live_openai(self, base: str, prompt: str, *, system: str) -> str:
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
        with httpx.Client(timeout=120.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]

    def _live_anthropic(self, base: str, prompt: str, *, system: str) -> str:
        # MiniMax / Anthropic 兼容：{base}/v1/messages
        url = f"{base}/v1/messages"
        payload: dict[str, Any] = {
            "model": self.settings.model,
            "max_tokens": 4096,
            "temperature": 0.4,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            payload["system"] = system
        headers = {
            "Authorization": f"Bearer {self.settings.api_key}",
            "x-api-key": self.settings.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        with httpx.Client(timeout=120.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            content = data.get("content") or []
            texts = [
                block.get("text", "")
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            ]
            text = "".join(texts).strip()
            if not text:
                raise ExecFailError(f"Anthropic 响应无文本: {data!r}")
            return text
