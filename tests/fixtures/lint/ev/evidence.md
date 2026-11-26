### E-001
**Claim:** Webhook payload is kept
**Verdict:** FOUND
**Searched:** orders, webhooks, audit
**Ref:** main@abc1234
**Evidence:** webhooks/models.py
**Notes:** deployed

### E-002a
**Claim:** Raw bank message is retained
**Verdict:** NOT FOUND
**Searched:** orders, webhooks, audit, raw, payload, history
**Ref:** main@abc1234
**Evidence:** none
**Notes:** nowhere; write paths traced: webhook processor

### E-003
**Claim:** Retry limit exists
**Verdict:** PARTLY
**Searched:**
**Ref:** main@abc1234
**Evidence:** none
**Notes:** x
