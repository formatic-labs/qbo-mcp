# Privacy Policy — CRM Connector

_Last updated: October 5, 2026_

**CRM Connector** is a private, internal integration used only by **CRM Services LLC**
(Vancouver, WA) to connect to its own QuickBooks Online company. It is built on the open-source
[`formatic-labs/qbo-mcp`](https://github.com/formatic-labs/qbo-mcp) server.

## Data we access
Only data in CRM Services LLC's own QuickBooks Online company that is needed for estimating:
customer records (names, contact details, billing and service addresses), products/services, and
estimates. Other QuickBooks data may be read on request by the owner for internal reporting.

## How data is used
Solely to create and update customers and estimates for CRM Services LLC's own jobs, at the direction
of the business owner. Data is **not sold, rented, shared with third parties, or used for advertising.**

## Where data is stored
CRM Connector does not keep a separate database of QuickBooks records; it reads and writes QuickBooks
Online directly. OAuth credentials (access and refresh tokens) are stored on hardware controlled by
CRM Services LLC and are never published or committed to source control. Job notes and quote drafts
are kept in CRM Services LLC's private repository.

## AI processing
Requests are made through Anthropic's Claude, operated by the business owner. Data passed through
Claude is subject to Anthropic's commercial terms and privacy policy.

## Access and revocation
Only the business owner and authorized CRM Services LLC personnel use CRM Connector. Access can be
revoked at any time by disconnecting the app in QuickBooks Online (Settings → Apps → Connected apps).

## Contact
CRM Services LLC — john@crmsvc.com
