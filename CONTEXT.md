# QHome Backend Domain Language

This glossary defines the business terms used by the QHome property-management backend. It keeps the bounded contexts aligned without prescribing implementation details.

## Property and Access

**Tenant**:
The project or building isolation boundary used for authorization and data partitioning.
_Avoid_: customer, organization, account

**Property**:
A managed real-estate portfolio containing one or more buildings and apartments.
_Avoid_: project, site

**Building**:
A physical structure inside a property that contains apartments and shared facilities.
_Avoid_: block, tower (unless a local business term requires it)

**Apartment**:
A resident-facing addressable unit in a building.
_Avoid_: unit, flat

**Resident**:
A person with an active or historical occupancy relationship to an apartment.
_Avoid_: customer, tenant

**Household**:
The group of residents associated with one apartment occupancy.
_Avoid_: family, account

**Occupancy**:
The time-bounded relationship between a resident or household and an apartment.
_Avoid_: ownership, assignment

**Property Manager (BQL)**:
An authorized operator who manages one or more tenants on behalf of the management board.
_Avoid_: admin (unless referring to a technical role)

## Operations and Finance

**Service Request**:
A resident- or manager-submitted request for help, repair, or a property operation.
_Avoid_: ticket, complaint

**Work Order**:
An actionable maintenance job created from a service request or a manager workflow.
_Avoid_: task, service request

**Invoice**:
An immutable request for payment containing billable charges for a resident or apartment.
_Avoid_: bill, payment request

**Ledger Entry**:
An append-only financial posting that records a debit, credit, payment, adjustment, or refund.
_Avoid_: transaction (too broad)

**Booking**:
A time-bounded reservation of a shared facility or amenity.
_Avoid_: appointment, reservation (unless the public API uses it as a compatibility alias)

**Visitor Pass**:
An access credential issued for a visitor with a bounded validity period and scope.
_Avoid_: guest ticket, invitation

**Announcement**:
An officially published message targeted to one or more tenants, buildings, or apartments.
_Avoid_: notification, broadcast

**Notification**:
A delivery record for a message sent to a specific recipient through one or more channels.
_Avoid_: announcement, alert

## Marketplace

**Marketplace Order**:
A resident purchase for an internal shop product or an on-demand home service, isolated by project and apartment.
_Avoid_: booking, request (those are narrower concepts)

**Home Service**:
An on-demand service performed at an apartment by an authorized partner or technician.
_Avoid_: maintenance request, amenity booking

**Service Partner**:
An external or internal provider responsible for fulfilling a marketplace order.
_Avoid_: vendor (use vendor only in the maintenance context)

**Technician Assignment**:
The time-bounded dispatch record connecting one marketplace order to a service partner or technician.
_Avoid_: booking, allocation

**Payment Saga**:
The order-owned workflow that coordinates payment intent creation, payment confirmation, dispatch, and refund compensation without a distributed transaction.
_Avoid_: payment transaction (owned by Billing)

## Identity and Authorization

**Project Membership**:
The relationship that grants a user access to one QHome project and carries the user's apartment and building scope.
_Avoid_: tenant account, organization membership

**Permission Override**:
An explicit user-level allow or deny that takes precedence over role-derived access within a project or building scope.
_Avoid_: role exception, ACL entry

**Session Family**:
The refresh-token rotation chain for one authenticated device session; reuse of any consumed token revokes the whole family.
_Avoid_: login token, refresh list

**Authorization Version**:
The monotonically increasing membership version embedded in access tokens and permission cache entries so changed access can invalidate stale decisions.
_Avoid_: JWT version, cache timestamp

## Documents

**Document**:
The stable business record and access boundary for a named piece of QHome content; file bytes live in object storage.
_Avoid_: file, blob

**Document Version**:
An immutable content revision of a document with its own object-storage key, MIME type, size, and SHA-256 checksum.
_Avoid_: overwrite, file revision

**Document Scope**:
The sharing boundary of a document: company, project, building, or resident apartment.
_Avoid_: visibility flag

**Access Policy**:
An explicit allow or deny rule for a document or folder, evaluated together with IAM permission and tenant scope.
_Avoid_: public link

**Multipart Upload**:
An object-storage upload session that transfers a large document in independently signed parts and is completed by a manifest.
_Avoid_: chunked API upload

## Workforce

**Task**:
An actionable unit of work owned by the workforce context, with an assignee, deadline, difficulty weight, and strict workflow state.
_Avoid_: ticket (unless the source is a resident complaint)

**Task Workflow Log**:
The append-only history of every task state transition, actor, reason, and correlation ID.
_Avoid_: task comment

**KPI Projection**:
The query-side monthly aggregate of task completion, timeliness, weighted difficulty, and rating for an employee or department.
_Avoid_: live task calculation

**Overdue Task**:
A task whose deadline passed before completion; it remains actionable and may transition back into progress.
_Avoid_: failed task

## Community Support

**News Feed Item**:
A published community message targeted to a project, building, apartment, or the whole resident community.
_Avoid_: notification (a delivery is separate from the message)

**Ticket**:
A resident support, complaint, or suggestion case with an owner, workflow state, priority, and SLA clock.
_Avoid_: announcement, task

**Notification Campaign**:
A durable instruction to deliver one rendered message to a target audience across one or more channels.
_Avoid_: push message, broadcast job

**Delivery Log**:
The immutable attempt history for delivering one campaign message through one provider channel.
_Avoid_: notification status

**SLA Breach**:
The point at which a ticket misses its response or resolution commitment and must be visible to operations.
_Avoid_: overdue task
