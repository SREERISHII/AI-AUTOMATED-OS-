## UI changes — chatbot-style recreation

I understand your request as:

You do not want the current interface where the user types into one large prompt box and receives a separate review panel.

You want the application to behave like a normal chatbot. All requests, plans, drafts, revisions, confirmations, and results should appear inside one continuous chat conversation.

### Current UI

```text
Large prompt box
↓
Create safe plan
↓
Separate review panel
↓
Confirm & execute
```

### New chatbot UI

```text
User message bubble
↓
Agent response bubble
↓
Email draft card or action-plan card
↓
User revision message
↓
Revised draft card
↓
Confirmation message
↓
Execution result message
```

Example:

```text
You:
Email itzrishrishi@gmail.com about my leave today because I need to attend a relative’s condolence ceremony.

Private OS Agent:
I created this email draft:

To: itzrishrishi@gmail.com
Subject: Leave Request for Today

Dear Sir/Madam,

I need to request leave today because I need to attend a relative’s condolence ceremony. I apologize for the short notice and appreciate your understanding.

Regards,
Rishi

Would you like to change anything?

You:
Make it more formal and mention that I will return tomorrow.

Private OS Agent:
Here is the revised draft:

To: itzrishrishi@gmail.com
Subject: Leave Request for Today

Dear Sir/Madam,

I respectfully request leave today as I need to attend a relative’s condolence ceremony. I apologize for the short notice. I will return tomorrow and complete any pending responsibilities.

Thank you for your understanding.

Regards,
Rishi

Would you like to revise it again or send it?

You:
Send it.

Private OS Agent:
This email will be sent to itzrishrishi@gmail.com. Do you confirm?

You:
Yes.

Private OS Agent:
Email sent successfully.
```

### Main UI changes

- Replace the large prompt box with a chat message input at the bottom.
- Display user requests as chat bubbles.
- Display agent responses as chat bubbles.
- Display email drafts as formatted cards.
- Display file plans as action cards.
- Display permission results inside the conversation.
- Display revision requests as normal user messages.
- Keep the entire conversation visible and scrollable.
- Allow multiple requests in one conversation.
- Add a “New conversation” button.
- Keep the `Alt + Space` popup shortcut.
- Add a typing/loading indicator while Ollama is planning.
- Add buttons such as:
  - Revise draft
  - Confirm and send
  - Cancel
  - Try again
  - Copy draft
- Keep technical errors hidden by default, with an optional “Technical details” section.

### Chat conversation states

The chat should understand these stages:

```text
Request received
→ Planning
→ Permission checking
→ Draft or action preview
→ Revision
→ Final confirmation
→ Execution
→ Result
```

For a file request:

```text
You:
Display files beginning with s in Documents.

Agent:
I found these items:
- Folder: School
- File: summary.txt
- File: sales-report.pdf
```

For a file operation:

```text
You:
Move invoice.pdf to the Invoices folder.

Agent:
I plan to move:
invoice.pdf
to:
Documents/Invoices/invoice.pdf

Confirm this move?
```

For an email:

```text
You:
Email my manager about leave.

Agent:
I need the recipient’s email address before drafting the message.
```

This means the chatbot itself becomes the main control center. The user will not need to switch between separate prompt, review, revision, and confirmation areas.

My understanding is that the `Alt + Space` popup should remain, but its inside content should become a complete chatbot conversation interface.
