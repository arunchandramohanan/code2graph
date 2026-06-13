import json
import base64
import requests
from anthropic import AnthropicVertex
from google.oauth2 import service_account

SERVICE_ACCOUNT_FILE = "service-account.json"
PROJECT_ID_NUMBER = "818763934039"
PROJECT_ID = "ailab-etg"
REGION_CLAUDE = "global"
REGION_GOOGLE = "us-central1"

credentials = service_account.Credentials.from_service_account_info(
    json.load(open(SERVICE_ACCOUNT_FILE)),
    scopes=["https://www.googleapis.com/auth/cloud-platform"],
)


def test_claude_models():
    print("=" * 50)
    print("CLAUDE MODELS (via AnthropicVertex SDK)")
    print("=" * 50)

    client = AnthropicVertex(
        region=REGION_CLAUDE,
        project_id=PROJECT_ID_NUMBER,
        credentials=credentials,
    )

    models = ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]

    for model in models:
        print(f"\n--- {model} ---")
        try:
            message = client.messages.create(
                model=model,
                max_tokens=256,
                messages=[{"role": "user", "content": "Say hello in one sentence."}],
            )
            print(f"  {message.content[0].text}")
            print(f"  Tokens: {message.usage.input_tokens} in / {message.usage.output_tokens} out")
        except Exception as e:
            print(f"  Error: {e}")


def test_gemini_models():
    print("\n" + "=" * 50)
    print("GEMINI MODELS (via generateContent REST API)")
    print("=" * 50)

    credentials.refresh(__import__("google.auth.transport.requests", fromlist=["Request"]).Request())
    token = credentials.token

    models = ["gemini-2.5-flash", "gemini-2.5-pro"]

    for model in models:
        print(f"\n--- {model} ---")
        try:
            url = f"https://{REGION_GOOGLE}-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{REGION_GOOGLE}/publishers/google/models/{model}:generateContent"
            resp = requests.post(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"contents": [{"role": "user", "parts": [{"text": "Say hello in one sentence."}]}]},
            )
            if resp.status_code == 200:
                text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                print(f"  {text}")
            else:
                print(f"  Error {resp.status_code}: {resp.json().get('error', {}).get('message', '')[:150]}")
        except Exception as e:
            print(f"  Error: {e}")


def test_imagen_models():
    print("\n" + "=" * 50)
    print("IMAGEN MODELS (via predict REST API)")
    print("=" * 50)

    credentials.refresh(__import__("google.auth.transport.requests", fromlist=["Request"]).Request())
    token = credentials.token

    models = [
        "imagen-4.0-ultra-generate-001",
        "imagen-4.0-generate-001",
        "imagen-4.0-fast-generate-001",
        "imagen-3.0-generate-002",
    ]

    for model in models:
        print(f"\n--- {model} ---")
        try:
            url = f"https://{REGION_GOOGLE}-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{REGION_GOOGLE}/publishers/google/models/{model}:predict"
            resp = requests.post(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={
                    "instances": [{"prompt": "A cute cat sitting on a windowsill"}],
                    "parameters": {"sampleCount": 1},
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                if "predictions" in data:
                    img_data = base64.b64decode(data["predictions"][0]["bytesBase64Encoded"])
                    filename = f"{model}.png"
                    with open(filename, "wb") as f:
                        f.write(img_data)
                    print(f"  Success! Saved to {filename} ({len(img_data) // 1024} KB)")
                else:
                    print(f"  Unexpected response: {json.dumps(data)[:150]}")
            else:
                print(f"  Error {resp.status_code}: {resp.json().get('error', {}).get('message', '')[:150]}")
        except Exception as e:
            print(f"  Error: {e}")


if __name__ == "__main__":
    test_claude_models()
    test_gemini_models()
    test_imagen_models()
