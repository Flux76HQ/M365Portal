// The id in the address of a detail page. The server accepts a GUID only, in lower case (EC-C15, PC-06): an
// address with anything else is a page that does not exist, so no request is made for it.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isGuid(value: string): boolean {
  return GUID.test(value);
}
