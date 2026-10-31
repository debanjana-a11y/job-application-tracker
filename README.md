# Job application tracker

A local job application tracker with three tabs:

- **Home** shows applications grouped by month.
- **Pipeline** lists applications, lets you update their status, and provides an edit action.
- **Settings** lets you add or edit an application manually, import applications from JSON, or sync matching messages from Gmail.

Application records and the Gmail sync checkpoint are stored in `data/applications.json`. The directory is created when the server starts.

Manual creates and edits are validated by the server and written to the JSON file. Edit an application from the Pipeline tab to update its company, role, status, or date.

Settings can import a JSON array of application records or an object containing an `applications` array. Each record must include `company`, `role`, `status` (`Applied`, `Interviewing`, or `Rejected`), and a `date` in `YYYY-MM-DD` format. Import replaces all current application records, preserves the Gmail sync checkpoint, and refreshes Home and Pipeline. Files are limited to 2 MB and 500 applications.

## Run locally

```sh
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Set `DATA_DIR` to change the directory used for the JSON file.

To enable Gmail sync, enter a Google OAuth Web application client ID in Settings and allow the page's origin. The app requests read-only Gmail access; its access token stays in the browser tab's memory.

## Run with Docker Compose

```sh
docker compose up -d --build
```

The app is available at [http://127.0.0.1:3000](http://127.0.0.1:3000). Compose stores `applications.json` in the persistent `application_data` volume.

Existing records in a previous MongoDB instance are not imported automatically. Export or copy them into the JSON store before removing any old database or volume.
