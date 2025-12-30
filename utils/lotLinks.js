// utils/lotLinks.js

function buildLotAddress(lot) {
  const line1 = (lot?.address_line1 || "").trim();
  const line2 = (lot?.address_line2 || "").trim();
  const city = (lot?.city || "").trim();
  const state = (lot?.state || "").trim();
  const zip = (lot?.zip || "").trim();

  const street = [line1, line2].filter(Boolean).join(", ");
  const cityStateZip = [city, state, zip].filter(Boolean).join(" ");
  return [street, cityStateZip].filter(Boolean).join(", ").trim();
}

function hasMeaningfulAddress(address) {
  if (!address) return false;
  const a = String(address).toLowerCase();
  const hasNumber = /\d/.test(a);
  const hasComma = a.includes(",");
  return hasNumber || hasComma;
}

function buildGoogleMapsUrlFromQuery(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    query
  )}`;
}

function buildNavigateLink(lot) {
  const hasGps =
    lot &&
    lot.latitude != null &&
    lot.longitude != null &&
    Number.isFinite(Number(lot.latitude)) &&
    Number.isFinite(Number(lot.longitude));

  if (hasGps) {
    const lat = Number(lot.latitude);
    const lng = Number(lot.longitude);
    const gps = `${lat},${lng}`;
    return {
      gpsLine: `${lat}, ${lng}`,
      url: buildGoogleMapsUrlFromQuery(gps),
      used: "gps",
    };
  }

  const address = buildLotAddress(lot);
  if (address && hasMeaningfulAddress(address)) {
    return {
      gpsLine: "",
      url: buildGoogleMapsUrlFromQuery(address),
      used: "address",
    };
  }

  const fallback = lot?.name || lot?.lot_code || "OpenYard lot";
  return {
    gpsLine: "",
    url: buildGoogleMapsUrlFromQuery(fallback),
    used: "name",
  };
}

function formatDateRange(startDate, endDate) {
  return `${startDate} to ${endDate}`;
}

export {
  buildLotAddress,
  hasMeaningfulAddress,
  buildNavigateLink,
  formatDateRange,
};
