# IntakeQ API Documentation Summary

## Base Information
- **Base URL:** `https://intakeq.com/api/v1/`
- **Authentication:** Header `X-Auth-Key: YOUR_API_KEY`

## 1. Client API
- **Query Clients:** `[GET] /clients?search={string}&includeProfile={bool}`
  - Search by name, email, or ClientId. Returns rich demographic and insurance data.
- **Save Clients:** `[POST] /clients`
  - Create or update clients (by matching ClientId or Name/Email).
- **Tags:**
  - `[POST] /clientTags` to add (`{ ClientId: 123, Tag: "text" }`).
  - `[DELETE] /clientTags?clientId=123&tag=text` to remove.
- **Diagnoses:** `[GET] /client/[clientId]/diagnoses`
  - Retrieves ICD codes and diagnosis details for a client.

## 2. Notes API
- **Query Summaries:** `[GET] /notes/summary?client={string}`
  - Returns list of treatment notes with ID and status.
- **Get Full Note:** `[GET] /notes/[note-id]`
  - Returns note object containing detailed `Questions` array, including matrices and URLs to attachment files.
- **Download Note PDF:** `[GET] /notes/[note-id]/pdf`
  - Downloads the final PDF of the lock treatment note.
- **Webhook:** Webhook URL can be configured to receive `{ NoteId, Type: "Note Locked", ClientId }` when a practitioner locks a note.

## 3. Files API
- **Get Client Files:** `[GET] /files?clientId=123`
  - Lists files (`Id`, `FileName`, `ContentType`) attached to a client profile.
- **Download File:** `[GET] /files/[fileId]`
  - Downloads specific file content.
- **Upload File:** `[POST] /files/[clientId]`
  - Uploads a new file (e.g., generated Auth Form) to a client's profile.
- **Delete File:** `[DELETE] /files/[fileId]`
