# Next Upgrades & Roadmap — Private OS Agent

Understood. We will not implement the next changes yet. Here is the complete update list for your review.

## 1. Convert the current popup into a chatbot interface

Replace the current large prompt-box layout with a conversation view containing:

- User messages
- Agent messages
- Planning messages
- Permission messages
- Email draft cards
- Revision messages
- Execution results
- A small message input at the bottom
- Send button
- Enter-to-send support
- Scrollable conversation history
- Clear conversation button

Example:

```text
You: Email my manager about leave today because of a relative’s condolence ceremony.

Agent: I created an email draft for you.

Agent:
To: manager@example.com
Subject: Leave Request for Today

Body:
Dear Manager,

I need to request leave today because I need to attend a relative’s condolence ceremony. I apologize for the short notice and will complete any pending work as soon as possible.

Regards,
Rishi

Agent: Would you like to change anything?

You: Make it more formal and mention that I will return tomorrow.

Agent: Here is the revised draft...

You: Send it.

Agent: Please confirm sending this email.
```

## 2. LLM-generated email composition

The LLM must generate the actual email content, including:

- Subject
- Greeting
- Main message
- Closing
- Appropriate tone
- Professional wording
- Context-specific language

The system must not simply copy the user’s sentence into the email body.

Supported examples:

- Leave requests
- Condolence-related leave
- Project delays
- Customer communication
- Invoice messages
- Academic requests
- Meeting requests
- Follow-ups
- Apologies
- Reminders
- General personal emails

## 3. Proper email revision workflow

When the user requests an email:

1. Extract the recipient.
2. Understand the purpose.
3. Generate a complete draft using Ollama.
4. Display the draft in the chatbot.
5. Ask whether changes are needed.
6. Accept natural-language changes.
7. Send the current draft plus the requested change back to Ollama.
8. Ask Ollama to generate a new complete draft.
9. Display the complete revised draft.
10. Repeat as many times as needed.
11. Send only after final user confirmation.

Examples of revision instructions:

```text
Make it more formal.
Make it shorter.
Use a friendly tone.
Add that I will return tomorrow.
Remove the apology.
Change the recipient.
Change the subject.
Mention that the document is attached.
```

The LLM should regenerate the full email, not perform basic text replacement.

## 4. Preserve email context during revisions

The revision planner must preserve:

- Recipient
- Subject
- Current body
- Attachments
- Original purpose
- Previous changes

Unless the user explicitly changes them.

For example, if the user only says:

```text
Make it shorter.
```

the recipient and attachments must remain unchanged.

## 5. Email confirmation safety

Before sending, display:

- Recipient
- Subject
- Full email body
- Attachments
- Attachment paths
- Attachment sizes
- Current sender account

Then ask:

```text
This email will be sent externally. Do you want to send it?
```

Only an explicit confirmation should trigger sending.

## 6. Chatbot intent handling

The chatbot should understand these intents:

- File listing
- File search
- Create file
- Create folder
- Rename
- Move
- Delete
- Open
- Compose email
- Revise email
- Send email
- Cancel operation
- Explain operation
- Show previous draft

## 7. File listing and search improvements

Current listing works for names beginning with a letter. Next improvements:

- List files and folders
- Filter by starting letter
- Search by partial name
- Search recursively
- Search by extension
- Show file type
- Show full relative path
- Show file size
- Show modified date
- Open a selected result
- Attach a selected result to an email

Examples:

```text
Show files beginning with s in Documents.
Find all PDFs containing invoice.
Search recursively for my resume.
Show folders inside Documents.
```

## 8. Permission manager improvements

The permission manager should independently check:

- Path safety
- System-folder access
- Sensitive files
- Attachment safety
- Email recipients
- Number of actions
- Destructive operations
- External data transmission
- Missing information
- User confirmation status

It must remain separate from the LLM. The LLM can propose an action, but it cannot grant itself permission.

## 9. Chat-based plan and execution flow

Each request should follow:

```text
User request
→ Ollama intent understanding
→ Ollama action plan
→ Permission manager
→ Chatbot explanation
→ User revision or confirmation
→ Dedicated agent
→ Execution
→ Result shown in chat
```

## 10. Better error handling

Instead of technical errors such as:

```text
ENOENT
ESOCKET
INVALID_FIELD_FOR_VERSION
```

the chatbot should show messages such as:

```text
I could not find that attachment in Documents.
```

```text
The email connection was interrupted by the network.
```

```text
The email credentials were rejected.
```

```text
I could not understand the requested revision. Please describe the change again.
```

Technical details can remain available under an expandable “Technical details” option.

## 11. Local privacy architecture

Keep these principles:

- Ollama runs locally.
- User prompts stay local during planning.
- File access stays local.
- Permission checking stays local.
- Email content leaves the computer only after confirmation.
- `.env` secrets are never displayed in chat.
- App passwords are never logged.
- TLS certificate validation must remain enabled.
- Audit logs must not include passwords or secrets.

## 12. Audit history

Record locally:

- User request
- Generated plan
- Email draft versions
- User revision requests
- Permission results
- Final confirmation
- Execution result
- Errors
- Timestamp

Do not record:

- Gmail App Password
- Normal Gmail password
- Full sensitive file contents
- Unapproved private data

## 13. Testing

Add tests for:

- Initial email generation
- Email revision
- Multiple revisions
- Recipient preservation
- Attachment preservation
- Subject changes
- Tone changes
- Empty revision requests
- Invalid recipient
- Missing attachment
- User cancellation
- Final confirmation
- File listing
- Recursive search
- Path traversal blocking

## 14. Packaging and usability

After the chatbot workflow is stable:

- Windows installer
- Start-menu shortcut
- Start-on-login option
- Settings screen
- Email configuration screen
- Ollama status indicator
- Model selection
- Clear logs button
- Permission policy settings

## Recommended implementation order

1. Fix LLM-generated email drafting.
2. Fix LLM-generated email revisions.
3. Convert the UI into a chatbot interface.
4. Add email draft cards and confirmation cards.
5. Improve file search and listing.
6. Improve permissions and error messages.
7. Add audit history.
8. Add tests.
9. Package the Windows application.
