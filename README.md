# Master Architecture Document: Propadi
> **Current Version:** v1.2  
> **Last Updated:** May 26, 2026  
> **Status:** Working Architectural Specification  

## 📜 Version History & Changelog
* **v1.2 (2026-05-26):** Formalized the Secure Viewing Handshake Protocol, implemented the Gatekeeper logic, and stabilized the chat UI using a Flex Wrap architecture.
* **v1.1 (2026-05-26):** Defined the Command Center, Application Hub, Tenancy Dossier integration, and regex-based Chat masking protocols.
* **v1.0 (2026-05-26):** Initial draft containing the core property management ecosystem and primary relational database schema.

---

## 1. Core Concept & Value Proposition
* **The Problem:** The rental market suffers from a severe trust deficit, off-platform payment scams, and a lack of verification regarding physical property inspections.
* **The Solution:** A comprehensive, end-to-end property management ecosystem ("Propadi") that enforces on-platform communication, facilitates digital tenancy agreements, and utilizes a cryptographic handshake to verify in-person property viewings securely.

---

## 2. Minimum Viable Product (MVP) User Journey
1. **Discovery & Application:** Renter submits an application via the Application Hub, generating a Tenancy Dossier for the Owner to review.
2. **Secure Communication:** Renter and Owner negotiate via the Propadi Chat interface. Sensitive financial terms and contact info are automatically masked to ensure platform integrity.
3. **The Gatekeeper (Scheduling):** Renter proposes a viewing schedule. The Owner receives a targeted UI prompt to "Accept" or "Decline" the proposal.
4. **In-Person Handshake:** Upon meeting at the property, the Renter displays a time-sensitive, dynamic QR code. The Owner scans this code via the Propadi Command Center to verify physical presence.
5. **Post-Viewing Validation:** The system securely validates the handshake token and GPS proximity, automatically transitioning the application status to unlock the final digital lease and payment gateway.

---

## 3. Technology Stack Selection
* **Frontend Framework:** React Native (Expo).
* **Backend Architecture:** Node.js with Express. 
* **Database Engine:** PostgreSQL (managed via Supabase).

---

## 4. Database Schema (Relational Architecture)

### Tables & Relationships
* **`Users` Table:** `user_id`, `role`, `created_at`
* **`Messages` Table:** `message_id`, `sender_id`, `receiver_id`, `property_id`, `message_text`, `date_sent`
* **`Applications` Table:** `application_id`, `renter_id`, `owner_id`, `property_id`, `status`, `dossier_data`
* **`Viewings` Table:** `id`, `application_id`, `renter_id`, `owner_id`, `property_id`, `status`, `scheduled_start_time`, `scheduled_end_time`, `secure_handshake_pin`, `pin_expiry`, `owner_checkin_location`, `renter_checkin_location`, `safety_alert_triggered`, `updated_at`

---

## 5. UI/UX Wireframe Structural Blueprints

### Screen 1: Secure Chat Interface (The Gatekeeper)
* **Header Block:** Dynamic routing back button, Property Title, and user verification ID.
* **Disclaimer Banner:** Role-specific safety and off-platform payment warnings.
* **Message Viewport:** FlatList rendering regex-masked message bubbles to prevent data leaks.
* **Input Engine:** Dynamic Flex Wrap "Suggestion Pills" (Accept/Decline) for Owners, and a role-restricted Calendar proposal toggle exclusively for Renters.

### Screen 2: Renter's Access Pass (Handshake)
* **Identity Block:** Property details and approved viewing time.
* **Dynamic QR Spotlight:** A self-refreshing (30-second loop) QR code component.
* **Fallback Protocol:** Clean typography displaying a 6-digit expiring PIN if scanning hardware fails.

### Screen 3: Owner's Security Scanner (Handshake)
* **Viewfinder Overlay:** Live Expo Camera scanner interface locked to QR detection.
* **Manual Override:** "Camera Not Working?" toggle to launch a numeric keypad for PIN entry.
* **Result Modal:** Visual success confirmation triggering backend state transition.

---

## 6. Security & Trust Architecture

### The Cryptographic Handshake Model
* **Token Expiration:** Validation PINs operate on a strict 5-minute rolling expiration to neutralize replay attacks.
* **Proximity Fencing:** The validation endpoint mandates that the GPS coordinates of both the Owner and Renter align with the registered property location at the exact moment of the handshake.

### Execution Protocols
* **System-Authoritative Generation:** Tokens are exclusively generated and hashed by the Node.js backend; the client side acts only as a display and transmission layer to prevent manipulation.
* **Auditability:** Every step of the viewing process updates the `updated_at` timestamp in the database, creating an immutable timeline for dispute resolution.

---

## 7. Current Challenges & Next Steps
* **Challenge 1:** Overcoming native rendering inconsistencies with dynamic horizontal layouts (Resolved via Flex Wrap architecture).
* **Challenge 2:** Ensuring definitive physical proximity between users during viewings (Resolved via the Secure Viewing Handshake).
* **Next Step (Technical):** Draft the functional system logic for the Node.js backend (`/api/viewings/generate-token`) to securely generate and store the dynamic viewing tokens.