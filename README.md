# Job application tracker
Demo: https://youtu.be/TYtCPTlnQrc

A local job application tracker with three tabs:

- **Home** shows applications grouped by month and lets you search by company, role, status, or date.
- **Pipeline** lists applications, lets you update their status, and provides an edit action.
- **Settings** lets you add or edit an application manually, import applications from JSON, or sync matching messages from Gmail.

Application records and the Gmail sync checkpoint are stored in `data/applications.json`. The directory is created when the server starts.

Manual creates and edits are validated by the server and written to the JSON file. Edit an application from the Pipeline tab to update its company, role, status, or date.

Settings can import a JSON array of application records or an object containing an `applications` array. Each record must include `company`, `role`, `status` (`Applied`, `Interviewing`, `Rejected`, or `Review`), and a `date` in `YYYY-MM-DD` format. Import replaces all current application records, preserves the Gmail sync checkpoint, and refreshes Home and Pipeline. Files are limited to 2 MB and 500 applications.

## Run locally

```sh
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Set `DATA_DIR` to change the directory used for the JSON file.

## Configure Ollama for Gmail classification

The local classifier sends email content to Ollama's chat API. Install and start Ollama, then download the model you want to use. For example:

```sh
ollama pull llama3.2:3b
```

The classifier needs Ollama reachable at its HTTP API address and the selected model available locally. Check installed models with `ollama list`.

### Running the classifier directly

In another terminal, create a Python environment, install the classifier dependencies, and start FastAPI:

```sh
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r python/requirements.txt
python -m uvicorn app:app --app-dir python --host 127.0.0.1 --port 8000
```

On Linux or macOS, use `source .venv/bin/activate` instead of the PowerShell activation command. Configure the classifier with these environment variables before starting Uvicorn:

| Variable | Default when running directly | Description |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server base URL. Do not include `/api/chat`; the classifier appends that path. |
| `OLLAMA_MODEL` | `llama3.2:3b` | Installed Ollama model tag used for classification. |
| `CLASSIFIER_REVIEW_THRESHOLD` | `0.5` | Confidence below which a job-related email is assigned `Review`. Must be between `0` and `1`. |

For example, on Linux or macOS:

```sh
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=llama3.2:3b
export CLASSIFIER_REVIEW_THRESHOLD=0.85
python -m uvicorn app:app --app-dir python --host 127.0.0.1 --port 8000
```

In PowerShell, set the same values with `$env:OLLAMA_BASE_URL`, `$env:OLLAMA_MODEL`, and `$env:CLASSIFIER_REVIEW_THRESHOLD` before running Uvicorn.

The classifier uses Ollama's `/api/chat` endpoint with streaming disabled and structured JSON output. Temperature is fixed at `0`, and each request has a 10-minute timeout; these are not environment-configurable.

To enable Gmail sync, enter a Google OAuth Web application client ID in Settings and allow the page's origin. The app requests read-only Gmail access; its access token stays in the browser tab's memory. Every sync searches all messages in Gmail's Updates category from the last 30 days, allowing previously missed messages to be reconsidered. Messages are sent to the local classifier in batches of up to 20, with each email classified separately. Already-tracked messages are deduplicated, unrelated messages are ignored, and related messages update the application for that company and role. Sync never modifies or deletes email.

## Run with Docker Compose

```sh
docker compose up -d --build
```

The app is available at [http://127.0.0.1:3000](http://127.0.0.1:3000). Compose stores `applications.json` in the persistent `application_data` volume and runs the classifier service. Set `OLLAMA_BASE_URL` to an address the classifier container can use to reach Ollama on the host.

Compose reads `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, and `CLASSIFIER_REVIEW_THRESHOLD` from the `.env` file beside `docker-compose.yml`, or uses these defaults:

| Variable | Compose default |
| --- | --- |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` |
| `OLLAMA_MODEL` | `llama3.2:1b` |
| `CLASSIFIER_REVIEW_THRESHOLD` | `0.85` |

Pull the configured model on the machine running Ollama (for example, `ollama pull llama3.2:1b`). The Compose URL must be reachable from inside the classifier container. On Linux, if `host.docker.internal` does not resolve in your Docker setup, set `OLLAMA_BASE_URL` in `.env` to an Ollama address reachable from the container. Restart/recreate the services after changing these values.

Existing records in a previous MongoDB instance are not imported automatically. Export or copy them into the JSON store before removing any old database or volume.
