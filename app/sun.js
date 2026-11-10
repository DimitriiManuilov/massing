/* ============================================================
   Положение солнца — алгоритм NOAA в изложении suncalc.
   Нужен, чтобы тени на модели соответствовали реальной инсоляции
   на выбранную дату и час в любой точке планеты.
   ============================================================ */

const rad = Math.PI / 180;
const dayMs = 86400000;
const J1970 = 2440588, J2000 = 2451545;
const e = rad * 23.4397;                        // наклон эклиптики

const toDays = date => date.valueOf() / dayMs - 0.5 + J1970 - J2000;

const rightAscension = (l, b) =>
  Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l, b) =>
  Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

function sunCoords(d) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

/**
 * @param {Date} date  момент в UTC
 * @param {number} lat широта, °
 * @param {number} lon долгота, °
 * @returns {{altitude:number, azimuth:number}} радианы; азимут от севера по часовой
 */
export function sunPosition(date, lat, lon) {
  const lw = rad * -lon, phi = rad * lat;
  const d = toDays(date), c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;

  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H)
  );
  // suncalc отсчитывает азимут от юга — приводим к компасному
  const azSouth = Math.atan2(
    Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi)
  );
  let azimuth = azSouth + Math.PI;
  if (azimuth > Math.PI * 2) azimuth -= Math.PI * 2;
  if (azimuth < 0) azimuth += Math.PI * 2;

  return { altitude, azimuth };
}

/**
 * Местное время участка → момент в UTC.
 * Смещение задаётся явно: по умолчанию оно берётся из долготы,
 * что даёт истинное солнечное время — для геометрии теней это
 * честнее административного пояса, который сдвинут на час-два.
 */
export function localTime(dateStr, minutes, tzHours) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + (minutes - tzHours * 60) * 60000);
}

/** Единичный вектор «на солнце» в осях сцены: X — восток, −Z — север. */
export function sunVector(altitude, azimuth) {
  const ca = Math.cos(altitude);
  return {
    x: Math.sin(azimuth) * ca,
    y: Math.sin(altitude),
    z: -Math.cos(azimuth) * ca
  };
}

export const fmtTime = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
