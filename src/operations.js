const fields = ["reference", "eventId", "name", "slot", "requestedAt", "desiredStatus"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "社区活动报名台账", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
