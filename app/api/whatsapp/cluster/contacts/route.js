import { json } from '../../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { getUserAssignment, nodeForAssignment } from '../../../../../lib/whatsapp-cluster';
import { nodeContactSearch } from '../../../../../lib/whatsapp-commands';


// Contact lookup for sending a document from the app (?q=name&groups=1).
export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('q') || '').trim().slice(0, 80);
  if (!query) return json({ matches: [] });
  const assignment = await getUserAssignment(access.user.id, access.client).catch(() => null);
  const node = assignment?.status === 'connected' ? nodeForAssignment(assignment) : null;
  if (!node) return json({ error: true, code: 'NOT_LINKED', message: 'اربط واتساب الشخصي أولاً.' }, 409);
  return json({ matches: await nodeContactSearch(node)(query, { groups: searchParams.get('groups') === '1' }) });
}
