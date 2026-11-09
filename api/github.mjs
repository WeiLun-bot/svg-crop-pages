import { createHandler } from '../server/github.mjs';

const handle = createHandler();
export default { fetch: request => handle(request, process.env) };
