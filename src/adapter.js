export const entryPath = "/events/E1/requests";

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["reference"]),
    source: "社区活动报名台账",
    observedAt: item["requestedAt"],
    label: String(item["name"]),
    attributes: structuredClone(item),
  })) };
}
