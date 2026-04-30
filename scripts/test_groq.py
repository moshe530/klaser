"""Quick test: does the GROQ_API_KEY actually work?
Run from project root:
    .venv\\Scripts\\python.exe scripts\\test_groq.py
"""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

key = os.getenv("GROQ_API_KEY", "")
if not key:
    print("FAIL: GROQ_API_KEY not found in .env")
    sys.exit(1)

print(f"Key found: {key[:10]}...{key[-4:]}")

try:
    from groq import Groq
except ImportError:
    print("FAIL: groq package not installed. Run: pip install groq")
    sys.exit(1)

client = Groq(api_key=key)

print("\nSending test request to Llama 4 Scout...")
try:
    response = client.chat.completions.create(
        model="meta-llama/llama-4-scout-17b-16e-instruct",
        messages=[{"role": "user", "content": "Say 'hello' in Hebrew. One word only."}],
        max_tokens=20,
    )
    print("\nSUCCESS! Response:")
    print(response.choices[0].message.content)
except Exception as e:
    print(f"\nFAILED: {type(e).__name__}")
    print(str(e)[:600])
    sys.exit(1)
