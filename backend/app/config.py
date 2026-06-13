from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "code2graph"

    # LLM access: "vertex" (service account) | "anthropic" (api key) | "" (disabled)
    llm_provider: str = "vertex"
    llm_model: str = "claude-opus-4-6"
    vertex_service_account: str = str(REPO_DIR / "llmaccess/service-account.json")
    vertex_project_id: str = "818763934039"
    vertex_region: str = "global"
    anthropic_api_key: str = ""

    java_extractor_jar: str = str(REPO_DIR / "extractors/java-extractor/target/java-extractor.jar")
    angular_extractor: str = str(REPO_DIR / "extractors/angular-extractor/dist/index.js")

    @property
    def llm_enabled(self) -> bool:
        from .services import llm

        return llm.enabled()


settings = Settings()
