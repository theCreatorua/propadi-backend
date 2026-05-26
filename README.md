markdown_content = """# Propadi Master Architecture Document (MAD)
**Version:** 1.1  
**Platform Focus:** Trust, Security, Simplicity  
**status:** Working Architectural Specification
**Tech Stack:** React Native (Expo), Supabase (PostgreSQL), Node.js/Express

## 1. System Ecosystem Overview
Propadi is partitioned into three core operational hubs that interact seamlessly to guide a user from property discovery to signed tenancy.

* **Command Center:** The centralized dashboard for active users. Houses the Maintenance Hub, Propadi Wallet, and the Trust & KYC verification engines.
* **Application Hub:** The administrative engine. Handles the lifecycle of rental applications, approval/disapproval workflows, digital tenancy agreement generation, payment validation, and digital signatures.
* **Secure Viewing Gateway:** The physical security bridge. Cryptographically validates that in-person property inspections happen at the correct time, at the correct location, and between the verified individuals.

## 2. The Secure Viewing Handshake (Protocol)
Designed to eliminate off-platform fraud, impersonation, and false "no-show" claims.

### The Validation Flow
1.  **Initiation (The Gatekeeper):** The Renter proposes a viewing time in the Chat UI. The Owner is presented with secure "Gatekeeper" flex-wrap UI buttons to "Accept" or "Decline."
2.  **Token Generation:** Upon Owner acceptance, the backend generates a time-sensitive, dynamic token linked to the specific `viewing_id`.
3.  **In-Person Handshake:**
    * **Primary (Dynamic QR):** The Renter's app displays a QR code that refreshes every 30 seconds (preventing screenshot sharing). The Owner scans this with their Expo Camera.
    * **Secondary (Fallback PIN):** If hardware/lighting fails, a 6-digit expiring PIN can be manually entered by the Owner.
4.  **Backend Verification:** The system verifies the token, checks the expiration time, and validates that the GPS coordinates of both devices match the property's registered location.
5.  **Completion:** The application status automatically upgrades to `completed`, unlocking the digital tenancy agreement in the Application Hub.

## 3. Database Schema: Master `viewings` Table
This schema serves as the immutable audit trail for physical inspections.

| Column Name | Data Type | Purpose & Security Function |
| :--- | :--- | :--- |
| `id` | `UUID` (PK) | Unique identifier for the viewing record. |
| `application_id` | `UUID` (FK) | Links the viewing to the Tenancy Dossier. |
| `renter_id` | `UUID` (FK) | Renter identity validation. |
| `owner_id` | `UUID` (FK) | Owner identity validation. |
| `property_id` | `UUID` (FK) | The property being inspected. |
| `status` | `ENUM` | `pending`, `accepted`, `declined`, `completed`, `no_show`. |
| `scheduled_start_time` | `TIMESTAMPTZ` | Approved start time of the inspection. |
| `scheduled_end_time` | `TIMESTAMPTZ` | Approved end time of the inspection. |
| `secure_handshake_pin` | `VARCHAR(6)` | The cryptographic validation token / QR payload. |
| `pin_expiry` | `TIMESTAMPTZ` | 5-minute rolling expiration to prevent replay attacks. |
| `owner_checkin_location` | `POINT` / `JSON` | GPS coordinates of the owner at the exact moment of validation. |
| `renter_checkin_location` | `POINT` / `JSON` | GPS coordinates of the renter at the exact moment of validation. |
| `safety_alert_triggered` | `BOOLEAN` | Defaults to `false`. Triggers if panic protocol is activated. |
| `created_at` | `TIMESTAMPTZ` | Record creation timestamp. |
| `updated_at` | `TIMESTAMPTZ` | Critical audit trail timestamp for status changes. |

## 4. Frontend UI/UX Standards
* **Chat Interface:** Utilizes robust flex-wrap layouts for system action pills (Accept/Decline) to guarantee layout stability across all Android and iOS devices, eliminating horizontal scroll clipping.
* **Data Masking:** Phone numbers, emails, and financial trigger words (e.g., "transfer", "bank drop") are automatically regex-masked in the chat to enforce on-platform communication until the tenancy is officially signed.
"""

file_path = "Propadi_Master_Architecture_Document_v1.1.md"

with open(file_path, "w", encoding="utf-8") as f:
    f.write(markdown_content)

print(f"Successfully generated {file_path}")
