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
