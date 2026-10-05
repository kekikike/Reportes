const zlib = require('zlib');

const W = 841.89, H = 595.28;      // A4 landscape (pt)
const ML = 40, MR = 40, MB = 50, MT = 74;

function esc(s) {
    return String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}

function r255(n) { return (n / 255).toFixed(3); }

function buildPdf({ title, subtitle, headers, widths, items }) {
    const nCol = widths.length;
    const tableW = widths.reduce((a, b) => a + b, 0);
    const x0 = (W - tableW) / 2;

    const pages = [''];
    function add(cmd) { pages[pages.length - 1] += cmd + '\n'; }
    function newPage() { pages.push(''); }

    let y = 0;
    function text(s, x, size, font, rgb) {
        add(`BT /${font} ${size} Tf ${rgb} 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${esc(s)}) Tj ET`);
    }
    function fill(x, w, h, rgb) {
        add(`${rgb} ${x.toFixed(1)} ${(y - 7).toFixed(1)} ${w.toFixed(1)} ${h} re f`);
    }
    function line() {
        add(`0.8 0.8 0.8 RG ${x0.toFixed(1)} ${y.toFixed(1)} ${(x0 + tableW).toFixed(1)} ${y.toFixed(1)} S`);
    }

    let first = true;
    function renderHeader() {
        fill(x0, tableW, 14, `${r255(37)} ${r255(99)} ${r255(235)}`);
        let x = x0;
        headers.forEach((h, i) => {
            text(h, x + 4, 9, 'F2', '1 1 1');
            x += widths[i];
        });
        y -= 18;
        line();
        y -= 5;
    }

    function ensure(need) {
        if (y - need < MB) {
            newPage();
            y = H - MT;
            renderHeader();
        }
    }

    pages[0] = '';
    y = H - MT;
    const tw = title.length * 8;
    // titulo centrado
    pages[0] += `BT /F2 16 Tf 0 0 0 rg 1 0 0 1 ${((W - tw) / 2).toFixed(1)} ${y} Tm (${esc(title)}) Tj ET\n`;
    y -= 20;
    pages[0] += `BT /F1 10 Tf 0.35 0.35 0.35 rg 1 0 0 1 ${(W / 2 - subtitle.length * 3).toFixed(1)} ${y} Tm (${esc(subtitle)}) Tj ET\n`;
    y -= 24;

    fill(x0, tableW, 14, `${r255(37)} ${r255(99)} ${r255(235)}`);
    let x = x0;
    headers.forEach((h, i) => {
        text(h, x + 4, 9, 'F2', '1 1 1');
        x += widths[i];
    });
    y -= 18;
    line();
    y -= 6;

    let prevDate = null;
    for (const it of items) {
        if (it.type === 'date') {
            ensure(18);
            fill(x0, tableW, 14, `${r255(238)} ${r255(242)} ${r255(255)}`);
            text(it.text, x0 + 6, 9, 'F2', `${r255(30)} ${r255(58)} ${r255(138)}`);
            y -= 18;
            line();
            y -= 6;
            prevDate = it.text;
        } else {
            ensure(14);
            let cx = x0;
            it.cells.forEach((c, i) => {
                text(String(c === null || c === undefined ? '' : c).substring(0, 32), cx + 4, 8, 'F1', '0 0 0');
                cx += widths[i];
            });
            y -= 14;
        }
    }

    // objetos y xref
    const streamPerPage = pages.map(p => zlib.deflateSync(p));
    const pageIds = [];
    const objects = [];
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    let offs = [0];
    let oid = 1;
    const kids = [];
    for (let i = 0; i < pages.length; i++) {
        const pageObj = streamPerPage[i];
        const plen = pageObj.length;
        const cur = oid + 3;
        pageIds.push(cur);
        kids.push(`${cur} 0 R`);
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents ${cur + 1} 0 R >>`,
            `<< /Length ${plen} >>\nstream\n${pageObj.toString('latin1')}\nendstream`,
        );
        oid += 2;
    }
    objects.unshift(''); // 1
    objects.unshift(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);

    // oids: 1 catalog, 2 pages, 3.. fonts? reordenar: construimos lista definitiva
    const list = ['<< /Type /Catalog /Pages 2 0 R >>']; // obj 1
    const fontF1 = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    const fontF2 = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

    // Construcción final de objetos con ids fijos:
    const objs = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
    objs[3] = fontF1;
    objs[4] = fontF2;
    let k = 5;
    for (let i = 0; i < pages.length; i++) {
        objs[k] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${k + 1} 0 R >>`;
        objs[k + 1] = `<< /Length ${streamPerPage[i].length} >>\nstream\n${streamPerPage[i].toString('latin1')}\nendstream`;
        k += 2;
    }

    let out = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 1; i <= k - 1; i++) {
        offsets[i] = Buffer.byteLength(out, 'latin1');
        out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xrefPos = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${k}\n0000000000 65535 f \n`;
    for (let i = 1; i <= k - 1; i++) {
        out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    out += `trailer\n<< /Size ${k} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

    return Buffer.from(out, 'latin1');
}

module.exports = buildPdf;