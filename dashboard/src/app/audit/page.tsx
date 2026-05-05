import { AuditLogTable } from '@/components/panels/AuditLogTable';

/**
 * Audit route. Static server component shell that delegates to a client
 * `<AuditLogTable />` for polling, payload expansion, and the Undo flow.
 *
 * T-1778244000000 (Wave 7 part 2 of the Factotem Dashboard v1 epic).
 */
export default function AuditPage() {
  return <AuditLogTable />;
}
