from enum import Enum
import json
import logging
import os
import re

from fastapi import FastAPI, HTTPException
import httpx
from pydantic import BaseModel, ConfigDict, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
OLLAMA_OUTPUT_LOG_LIMIT = 10000


class ApplicationStatus(str, Enum):
  APPLIED = "Applied"
  INTERVIEWING = "Interviewing"
  REJECTED = "Rejected"
  REVIEW = "Review"


class ReconcileEmailRequest(BaseModel):
  model_config = ConfigDict(extra="forbid")

  email_id: str = Field(min_length=1, max_length=200)
  sender: str = Field(max_length=500)
  subject: str = Field(max_length=1000)
  body_snippet: str

class ReconcileEmailResponse(BaseModel):
  is_job_related: bool
  status: ApplicationStatus
  company: str = Field(max_length=120)
  role: str = Field(max_length=120)
  confidence: float = Field(ge=0, le=1)

app = FastAPI(title="Job Tracker Email Classifier", version="1.0.0")
review_threshold = float(os.getenv("CLASSIFIER_REVIEW_THRESHOLD", "0.5"))
if not 0 <= review_threshold <= 1:
  raise ValueError("CLASSIFIER_REVIEW_THRESHOLD must be between 0 and 1.")

def classification_schema() -> dict:
  schema = ReconcileEmailResponse.model_json_schema()
  schema["additionalProperties"] = False
  return schema

def explicit_application_status(
    email: ReconcileEmailRequest,
) -> ApplicationStatus | None:
  content = f"{email.subject}\n{email.body_snippet}".lower()
  if re.search(
      r"\b(regret to inform|not moving forward|not selected|"
      r"application (?:was|has been) (?:unsuccessful|rejected)|"
      r"decided not to proceed|will not be moving forward|"
      r"won't be moving forward|move forward with other candidates|"
      r"proceed with other candidates|position has been filled)\b",
      content,
  ):
    return ApplicationStatus.REJECTED
  if re.search(
      r"\b(invite(?:d)? (?:you )?to (?:an? )?interview|"
      r"interview invitation|schedule(?:d)? (?:an? )?interview|"
      r"technical assessment|next round interview)\b",
      content,
  ):
    return ApplicationStatus.INTERVIEWING
  if re.search(
      r"\b(application successful|application received|received your"
      r" application|thank you for applying|thanks for applying|confirming your"
      r" application|application (?:was )?submitted)\b",
      content,
  ):
    return ApplicationStatus.APPLIED
  if re.search(
      r"\bthank you for your interest|thanks for considering\b", content
  ):
    return ApplicationStatus.REVIEW
  return None


@app.get("/health")
async def health() -> dict[str, str]:
  return {"status": "ok"}


@app.post("/api/reconcile-email", response_model=ReconcileEmailResponse)
async def reconcile_email(
    email: ReconcileEmailRequest,
) -> ReconcileEmailResponse:

  ollama_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
  model = os.getenv("OLLAMA_MODEL", "llama3.2:3b")

  # 2. Structured prompt explicitly instructing company, role, status, and confidence
  prompt = (
    "Understand the intent of email below, classify the job application vs non-nob application emails and based on that classify the job application status. "
    "Do not consider recommended or promotion of Jobs\n\n"
    "CRITICAL RULE - COURTESY VS OUTCOME:\n"
    "1. Polite opening statements like 'Thank you for submitting your CV' or"
    " 'We appreciate your interest' are standard courtesy.\n"
    "2. If the email contains ANY statement indicating non-selection"
    " ('unsuccessful', 'not moving forward', 'pursuing other candidates',"
    " 'position closed'), the outcome is REJECTED, regardless of any 'Thank"
    " you' at the beginning.\n"
    "3. Only mark as 'Applied' if it is STRICTLY a confirmation of receipt with"
    " no decision made yet.\n\n"
    "Output fields in order:\n"
    "- key_phrase: Copy the single sentence that states the final outcome or"
    " next step.\n"
    "- is_job_related: true/false\n"
    "- status: Rejected | Interviewing | Applied | Review\n"
    "- company: Hiring company name\n"
    "- role: Job title\n"
    "- confidence: 0.0 to 1.0\n\n"
    "Email Content:\n"
    f"Sender: {email.sender}\n"
    f"Subject: {email.subject}\n"
    f"Body: {email.body_snippet}\n"
  )

  payload = {
      "model": model,
      "stream": False,
      "format": classification_schema(),
      "messages": [
          {
              "role": "system",
              "content": (
                  "You classify job application emails and return strictly"
                  " schema-valid JSON."
              ),
          },
          {"role": "user", "content": prompt},
      ],
      "options": {"temperature": 0},
  }

  try:
    async with httpx.AsyncClient(timeout=600) as client:
      response = await client.post(f"{ollama_url}/api/chat", json=payload)
      response.raise_for_status()
  except httpx.TimeoutException as error:
    raise HTTPException(
        status_code=504, detail="Ollama classification timed out."
    ) from error
  except httpx.HTTPError as error:
    raise HTTPException(
        status_code=502, detail="Ollama classification failed."
    ) from error

  model_content = ""
  try:
    model_content = response.json()["message"]["content"]
    logger.info("### prompt: %s", prompt)
    logger.info("Ollama output: %s", model_content[:OLLAMA_OUTPUT_LOG_LIMIT])
    result = ReconcileEmailResponse.model_validate(json.loads(model_content))
  except (KeyError, TypeError, ValueError) as error:
    logger.warning(
        "Ollama returned invalid classification: %s; raw: %s",
        error,
        model_content[:OLLAMA_OUTPUT_LOG_LIMIT] or "<unavailable>",
    )
    raise HTTPException(
        status_code=502, detail="Ollama returned an invalid classification."
    ) from error

  # 3. Confidence threshold enforcement
  if not result.is_job_related or result.confidence < review_threshold:
    result.status = ApplicationStatus.REVIEW

  return result