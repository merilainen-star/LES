# Privacy Policy for Lekolar Enhancer

Last updated: June 2, 2026

Lekolar Enhancer is a Microsoft Edge browser extension that improves internal productivity on Lekolar websites. It adds product copy tools, browsing helpers, product notes, product comparison/list tools, PowerPoint and CSV exports, SharePoint search helpers, and optional AI Search and translation features.

This privacy policy describes what information the extension accesses, stores, and transmits, what controls users have, and how users can access or delete their information.

## Information the Extension Accesses

Lekolar Enhancer runs on the Lekolar country websites declared in the extension manifest:

- `lekolar.fi`
- `lekolar.se`
- `lekolar.no`
- `lekolar.dk`

On those sites, the extension reads page content needed to provide its user-facing features. This can include product numbers, product names, product descriptions, specifications, product images, product URLs, cart item details, selected text, search terms typed into extension features, and other visible Lekolar page content required for copy, browsing, comparison, export, search, translation, and AI Search workflows.

The extension may also access `lekolarab.sharepoint.com` for optional internal SharePoint search and status checks.

## Information Stored in Microsoft Edge

Lekolar Enhancer stores information in the user's Microsoft Edge browser storage to make the extension work and remember user preferences. This may include:

- Extension settings and feature toggles
- Enabled Lekolar country sites
- Copy-format preferences
- Product layout preferences
- Product comparison and list state
- Personal product notes entered by the user
- AI Search query history
- Optional AI provider settings
- Optional encrypted AI provider API keys
- Cached SharePoint access/status information

This information is stored locally in the user's browser profile. The extension does not operate a separate server that collects this information from users.

## Optional Third-Party Services

External services are disabled by default. The extension does not send AI Search queries or translation text to third-party services unless the user enables the external-services consent setting in the extension.

When external services are enabled, the extension may send only the text needed for the selected feature to the selected service:

- MyMemory, for translation
- OpenAI, for optional AI Search
- Anthropic, for optional AI Search
- Google Gemini, for optional AI Search

The extension uses these services only to provide user-facing translation or AI Search features requested by the user. The extension does not use these services for advertising, data brokering, creditworthiness, lending, or unrelated purposes.

Users should also review the privacy terms of any third-party AI or translation provider they choose to use.

## Clipboard Use

Lekolar Enhancer uses the clipboard only when the user activates a copy action. The extension can write product numbers, product names, product links, formatted product information, product images, and extension sharing links to the clipboard.

## User Controls

Users control the extension's behavior through the extension popup and settings page. Users can:

- Turn the extension on or off
- Enable or disable individual features
- Enable or disable the extension for individual Lekolar country sites
- Change copy formats and layout preferences
- Enable or disable external services consent
- Choose whether to configure AI Search
- Add, export, import, or delete personal product notes
- Export or reset extension settings
- Remove saved AI provider API keys

If the user turns off external-services consent, the extension stops sending AI Search queries and translation text to third-party services.

## Accessing and Deleting Information

Users can access and manage extension settings from the Lekolar Enhancer settings page in Microsoft Edge.

Users can delete stored information by:

- Deleting personal product notes from the extension notes interface
- Removing saved AI provider API keys from settings
- Resetting extension settings to defaults
- Clearing Microsoft Edge extension storage/site data
- Uninstalling the extension from Microsoft Edge

Uninstalling the extension removes extension-managed browser storage according to Microsoft Edge's extension storage behavior.

## Data Sharing

Lekolar Enhancer does not sell user data. Lekolar Enhancer does not transfer user data to third parties for purposes unrelated to the extension's single purpose. Lekolar Enhancer does not use or transfer user data to determine creditworthiness or for lending purposes.

The extension only transmits information to third-party services when required for a user-facing feature and, for AI Search or translation, only after the user enables external-services consent.

## Security

Network requests to Lekolar sites, SharePoint, MyMemory, OpenAI, Anthropic, and Google Gemini use HTTPS endpoints. Optional AI provider API keys are stored locally in Microsoft Edge browser storage in encrypted form where supported by the extension implementation, and API keys are not included in settings backup/export files.

No browser storage is immune to malware or to someone who already has access to the user's device or browser profile. Users should protect their device, Microsoft Edge profile, and third-party API provider accounts.

## Children's Privacy

Lekolar Enhancer is intended for internal productivity workflows and is not directed to children under 13.

## Changes to This Policy

This privacy policy will be updated when Lekolar Enhancer adds or changes features that affect data access, storage, sharing, or user controls.

## Contact

For questions about this privacy policy or Lekolar Enhancer, contact the maintainer through the project repository:

https://github.com/merilainen-star/LES
