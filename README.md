# Job application tracker
Demo: https://youtu.be/TYtCPTlnQrc

A local job application tracker with three tabs:

- **Home** shows applications grouped by month.
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

For Gmail classification, start Ollama and download a model:

```sh
ollama pull llama3.2:3b
```

In another terminal, create a Python environment, install the classifier dependencies, and start FastAPI:

```sh
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r python/requirements.txt
python -m uvicorn app:app --app-dir python --host 127.0.0.1 --port 8000
```

On Linux or macOS, use `source .venv/bin/activate` instead of the PowerShell activation command. Set `OLLAMA_BASE_URL` and `OLLAMA_MODEL` if Ollama uses a different address or model. The confidence threshold defaults to `0.85`; related emails below it receive `Review`.

To enable Gmail sync, enter a Google OAuth Web application client ID in Settings and allow the page's origin. The app requests read-only Gmail access; its access token stays in the browser tab's memory. Every sync searches all messages in Gmail's Updates category from the last 30 days, allowing previously missed messages to be reconsidered. Messages are sent to the local classifier in batches of up to 20, with each email classified separately. Already-tracked messages are deduplicated, unrelated messages are ignored, and related messages update the application for that company and role. Sync never modifies or deletes email.

## Run with Docker Compose

```sh
docker compose up -d --build
```

The app is available at [http://127.0.0.1:3000](http://127.0.0.1:3000). Compose stores `applications.json` in the persistent `application_data` volume and runs the classifier service. Set `OLLAMA_BASE_URL` to an address the classifier container can use to reach Ollama on the host.

Existing records in a previous MongoDB instance are not imported automatically. Export or copy them into the JSON store before removing any old database or volume.
