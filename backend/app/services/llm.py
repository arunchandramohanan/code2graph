"""Single LLM access point. Provider: Vertex AI (service account) or Anthropic API key.

Used by enrichment (summaries, community labels) and the tier-3 linker fallback.
"""

import json
import logging
import threading
from pathlib import Path

from ..config import settings

log = logging.getLogger(__name__)

_client = None
_lock = threading.Lock()


def enabled() -> bool:
    if settings.llm_provider == "vertex":
        return Path(settings.vertex_service_account).is_file()
    if settings.llm_provider == "anthropic":
        return bool(settings.anthropic_api_key)
    return False


def _get_client():
    global _client
    with _lock:
        if _client is not None:
            return _client
        if settings.llm_provider == "vertex":
            from anthropic import AnthropicVertex
            from google.oauth2 import service_account

            credentials = service_account.Credentials.from_service_account_info(
                json.loads(Path(settings.vertex_service_account).read_text()),
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
            _client = AnthropicVertex(
                region=settings.vertex_region,
                project_id=settings.vertex_project_id,
                credentials=credentials,
            )
        else:
            from anthropic import Anthropic

            _client = Anthropic(api_key=settings.anthropic_api_key)
        return _client


def complete(prompt: str, max_tokens: int = 800) -> str:
    """One-shot completion; raises on failure (callers decide how to degrade)."""
    if not enabled():
        raise RuntimeError("LLM is not configured")
    msg = _get_client().messages.create(
        model=settings.llm_model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(block.text for block in msg.content if block.type == "text")


def create_with_tools(system: str, messages: list, tools: list, max_tokens: int = 2500):
    """Raw messages call with tool definitions — used by the agentic ask loop."""
    if not enabled():
        raise RuntimeError("LLM is not configured")
    return _get_client().messages.create(
        model=settings.llm_model,
        max_tokens=max_tokens,
        system=system,
        messages=messages,
        tools=tools,
    )
