import React, { useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  Legend,
  LineChart,
  Line,
} from 'recharts';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import './App.css';

/* ---------- formatters ---------- */
const inr0 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const inr2 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const nf1 = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/* Helper to safely parse numbers and clamp */
const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

/* Default values */
const DEFAULTS = {
  monthlyBill: 30130,
  unitsMonth: 3913,
  avgGen: 4.5, // kWh/kW/day
  ppaRate: 7.5, // ₹/kWh
  degradation: 0.5, // %
  years: 5,
};

/* ---- Recharts: pretty tooltips ---- */
const tooltipBox = {
  background: '#0a132a',
  border: '1px solid #24304f',
  borderRadius: 10,
  padding: '8px 10px',
  color: '#e8eeff',
  boxShadow: '0 8px 24px rgba(0,0,0,.35)',
  maxWidth: 260,
  fontSize: 12,
};
const tooltipTitle = { fontWeight: 700, color: '#9fb0df', marginBottom: 6 };
const rowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 16,
  lineHeight: 1.3,
};

const MonthlyTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload || {};
  // Determine which bar was hovered
  const item = payload[0];
  const isUtility = item?.dataKey === 'Utility';
  const isPPA = item?.dataKey === 'PPA';
  const title = label;
  const bill = item?.value ?? 0;
  const rate = isUtility ? p.UtilityRate : isPPA ? p.PPARate : null;
  const name = isUtility ? 'Current Bill' : 'PPA Bill';
  return (
    <div style={tooltipBox}>
      <div style={tooltipTitle}>{title}</div>
      <div style={rowStyle}>
        <span>{name}</span>
        <span style={{ fontWeight: 700 }}>{inr0.format(bill)}</span>
      </div>
      {rate != null && (
        <div style={rowStyle}>
          <span>Rate</span>
          <span style={{ fontWeight: 700 }}>{inr2.format(rate)}/kWh</span>
        </div>
      )}
    </div>
  );
};

const LineTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={tooltipBox}>
      <div style={tooltipTitle}>Year {label}</div>
      <div style={rowStyle}>
        <span>Savings</span>
        <span style={{ fontWeight: 700 }}>{inr0.format(payload[0].value)}</span>
      </div>
    </div>
  );
};

export default function App() {
  const rootRef = useRef(null);

  /* ---------------- state ---------------- */
  const [inputs, setInputs] = useState({
    monthlyBill: DEFAULTS.monthlyBill,
    unitsMonth: DEFAULTS.unitsMonth,
    avgGen: DEFAULTS.avgGen,
    ppaRate: DEFAULTS.ppaRate,
    degradation: DEFAULTS.degradation,
    years: DEFAULTS.years,
  });

  const [touched, setTouched] = useState({});
  const [calcKey, setCalcKey] = useState(0); // bump to "recalculate" on demand

  /* ---------------- validation ---------------- */
  const errors = useMemo(() => {
    const e = {};
    if (!(inputs.monthlyBill >= 0)) e.monthlyBill = 'Must be a number ≥ 0.';
    if (!(inputs.unitsMonth >= 1)) e.unitsMonth = 'Must be a number ≥ 1.';
    if (!(inputs.avgGen >= 0.1)) e.avgGen = 'Must be a number ≥ 0.1.';
    if (!(inputs.ppaRate >= 0.1)) e.ppaRate = 'Must be a number ≥ 0.1.';
    if (!(inputs.degradation >= 0 && inputs.degradation <= 3))
      e.degradation = 'Must be between 0% and 3%.';
    if (
      !Number.isInteger(Number(inputs.years)) ||
      !(inputs.years >= 1 && inputs.years <= 25)
    )
      e.years = 'Years must be an integer between 1 and 25.';
    return e;
  }, [inputs]);

  const hasErrors = Object.keys(errors).length > 0;

  /* ---------------- derived (auto) ---------------- */
  const auto = useMemo(() => {
    const unitsPerDay = inputs.unitsMonth > 0 ? inputs.unitsMonth / 30 : 0;
    const utilityRate =
      inputs.unitsMonth > 0 ? inputs.monthlyBill / inputs.unitsMonth : 0;
    const kWNeeded = inputs.avgGen > 0 ? unitsPerDay / inputs.avgGen : 0;
    return {
      unitsPerDay,
      utilityRate,
      kWNeeded: Math.round(kWNeeded * 10) / 10,
    };
  }, [inputs, calcKey]); // calcKey to only refresh on Calculate (UX choice)

  /* ---------------- PPA + savings calculations ---------------- */
  const results = useMemo(() => {
    // Only compute when Calculate pressed (calcKey dependency)
    const units = Math.max(1, Number(inputs.unitsMonth) || 0);
    const bill = Math.max(0, Number(inputs.monthlyBill) || 0);
    const ppaRate = Math.max(0.1, Number(inputs.ppaRate) || 0);
    const degPct = clamp(Number(inputs.degradation) || 0, 0, 3); // %
    const years = clamp(Math.round(Number(inputs.years) || 1), 1, 25);

    const monthlyPPA = units * ppaRate;
    const monthlySavings = bill - monthlyPPA;

    const yearlyPPA1 = monthlyPPA * 12;
    const yearlySavings1 = monthlySavings * 12;

    // Model A: savings over contract with degradation on covered units
    const d = degPct / 100;
    const yearly = [];
    let totalSavings = 0;

    for (let y = 1; y <= years; y++) {
      const units_y = units * Math.pow(1 - d, y - 1);
      const ppa_month_y = units_y * ppaRate;
      const savings_year_y = 12 * (bill - ppa_month_y);
      yearly.push({
        year: `Year ${y}`,
        yearIndex: y,
        savings: Math.round(savings_year_y),
        exact: savings_year_y,
      });
      totalSavings += savings_year_y;
    }

    const avgYearly = totalSavings / years;

    return {
      monthlyPPA,
      monthlySavings,
      yearlyPPA1,
      yearlySavings1,
      yearly,
      totalSavings,
      avgYearly,
      negativeNow: monthlySavings < 0,
      warnHigher: monthlyPPA >= bill,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calcKey]); // only recompute on explicit Calculate

  /* ---------------- handlers ---------------- */
  const onChange = (name, raw) => {
    setInputs((p) => ({ ...p, [name]: raw === '' ? '' : Number(raw) }));
  };
  const onBlur = (name) => setTouched((t) => ({ ...t, [name]: true }));

  const calculate = () => {
    if (hasErrors) {
      setTouched({
        monthlyBill: true,
        unitsMonth: true,
        avgGen: true,
        ppaRate: true,
        degradation: true,
        years: true,
      });
      return;
    }
    setCalcKey((k) => k + 1);
  };

  const resetAll = () => {
    setInputs({ ...DEFAULTS });
    setTouched({});
    setCalcKey((k) => k + 1);
  };

  const downloadPDF = async () => {
    const node = rootRef.current;
    if (!node) return;

    // 1️⃣ Hide header temporarily (title + buttons)
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';

    // 2️⃣ Enter pdf mode
    document.body.classList.add('pdf-mode');
    await new Promise((r) => setTimeout(r, 250));

    // 3️⃣ Capture high-resolution canvas
    const SCALE = 3;
    const canvas = await html2canvas(node, {
      scale: SCALE,
      useCORS: true,
      backgroundColor: '#ffffff',
      windowWidth: document.documentElement.scrollWidth,
      windowHeight: document.documentElement.scrollHeight,
    });

    // 4️⃣ Prepare A4 PDF setup
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'pt',
      format: 'a4',
    });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 24;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2;

    const imgWpx = canvas.width;
    const imgHpx = canvas.height;
    const pxPerPt = imgWpx / usableW;
    const pageSliceHpx = Math.floor(usableH * pxPerPt);

    let sliceTop = 0;
    let pageIndex = 0;

    while (sliceTop < imgHpx) {
      const sliceH = Math.min(pageSliceHpx, imgHpx - sliceTop);

      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = imgWpx;
      pageCanvas.height = sliceH;
      const ctx = pageCanvas.getContext('2d');
      ctx.drawImage(canvas, 0, sliceTop, imgWpx, sliceH, 0, 0, imgWpx, sliceH);

      const imgData = pageCanvas.toDataURL('image/png');

      if (pageIndex > 0) pdf.addPage();
      pdf.addImage(
        imgData,
        'PNG',
        margin,
        margin,
        usableW,
        sliceH / pxPerPt,
        undefined,
        'FAST'
      );

      // Footer text and page number
      pdf.setFontSize(10);
      pdf.setTextColor('#555');
      pdf.text(
        'Generated with Solar PPA Savings Calculator',
        pageW - margin,
        pageH - 10,
        { align: 'right' }
      );
      pdf.text(`Page ${pageIndex + 1}`, margin, pageH - 10, { align: 'left' });

      sliceTop += sliceH;
      pageIndex++;
    }

    // 5️⃣ Restore styles and header
    document.body.classList.remove('pdf-mode');
    if (header) header.style.display = '';

    // 6️⃣ Save file
    pdf.save('Solar-PPA-Savings.pdf');
  };

  /* ---------------- Charts data ---------------- */
  // For better visuals: two series (Utility, PPA) across two categories,
  // with only one active per row (the other is null). This lets us color them differently
  // and keep a tidy legend + gradient fills.
  const monthlyBarData = useMemo(() => {
    const utilityRate =
      inputs.unitsMonth > 0 ? inputs.monthlyBill / inputs.unitsMonth : 0;
    return [
      {
        name: 'Current Monthly Bill',
        Utility: Math.max(0, Number(inputs.monthlyBill) || 0),
        PPA: null,
        UtilityRate: utilityRate,
        PPARate: Math.max(0.1, Number(inputs.ppaRate) || 0),
      },
      {
        name: 'PPA (Year 1)',
        Utility: null,
        PPA: Math.max(0, Number(results.monthlyPPA) || 0),
        UtilityRate: utilityRate,
        PPARate: Math.max(0.1, Number(inputs.ppaRate) || 0),
      },
    ];
  }, [
    inputs.monthlyBill,
    inputs.unitsMonth,
    inputs.ppaRate,
    results.monthlyPPA,
  ]);

  const lineData = useMemo(
    () =>
      results.yearly.map((y) => ({
        name: y.yearIndex,
        Savings: Math.round(y.exact),
      })),
    [results.yearly]
  );

  /* ---------------- UI helpers ---------------- */
  const Field = ({ id, label, suffix, helper, error, ...rest }) => (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className={`control ${error ? 'has-error' : ''}`}>
        <input
          id={id}
          aria-describedby={helper ? `${id}-help` : undefined}
          {...rest}
        />
        {suffix ? (
          <span className="suffix" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
      </div>
      {helper ? (
        <div id={`${id}-help`} className="help">
          {helper}
        </div>
      ) : null}
      {error ? (
        <div className="error" role="alert" aria-live="polite">
          {error}
        </div>
      ) : null}
    </div>
  );

  const Readonly = ({ label, value, helper }) => (
    <div className="ro">
      <div className="ro-label">{label}</div>
      <div className="ro-value">{value}</div>
      {helper ? <div className="ro-help">{helper}</div> : null}
    </div>
  );

  /* ---------------- render ---------------- */
  return (
    <div className="app" ref={rootRef} id="app-root">
      <header className="header">
        <div className="title">
          Solar PPA Savings Calculator
          <span className="badge">v1</span>
        </div>
        <div className="actions">
          <button
            className="btn secondary"
            type="button"
            onClick={resetAll}
            aria-label="Reset to defaults"
          >
            Reset
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={calculate}
            disabled={hasErrors}
            aria-disabled={hasErrors}
            aria-label="Calculate savings"
          >
            Calculate
          </button>
          <button
            className="btn outline"
            type="button"
            onClick={downloadPDF}
            aria-label="Download PDF"
          >
            Download PDF
          </button>
        </div>
      </header>

      <main className="grid">
        {/* Input card */}
        <section className="card">
          <h2>Inputs</h2>
          <div className="form-grid">
            <Field
              id="monthlyBill"
              label="Monthly Power Bill (₹)"
              type="number"
              min="0"
              step="1"
              value={inputs.monthlyBill}
              onChange={(e) => onChange('monthlyBill', e.target.value)}
              onBlur={() => onBlur('monthlyBill')}
              error={touched.monthlyBill && errors.monthlyBill}
              helper="Enter your typical total electricity bill."
            />
            <Field
              id="unitsMonth"
              label="Units Consumed per Month (kWh)"
              type="number"
              min="1"
              step="1"
              value={inputs.unitsMonth}
              onChange={(e) => onChange('unitsMonth', e.target.value)}
              onBlur={() => onBlur('unitsMonth')}
              error={touched.unitsMonth && errors.unitsMonth}
              helper="Total monthly energy consumption."
            />
            <Field
              id="avgGen"
              label="Average Generation per kW per day (kWh/kW/day)"
              type="number"
              min="0.1"
              step="0.1"
              value={inputs.avgGen}
              onChange={(e) => onChange('avgGen', e.target.value)}
              onBlur={() => onBlur('avgGen')}
              error={touched.avgGen && errors.avgGen}
              helper="Typical site yield per kW installed (varies by location/tilt/shading)."
            />
            <Field
              id="ppaRate"
              label="PPA Unit Cost (₹/kWh)"
              type="number"
              min="0.1"
              step="0.1"
              value={inputs.ppaRate}
              onChange={(e) => onChange('ppaRate', e.target.value)}
              onBlur={() => onBlur('ppaRate')}
              error={touched.ppaRate && errors.ppaRate}
              helper="Your Solar PPA rate."
            />
            <Field
              id="degradation"
              label={
                <>
                  Panel Degradation (%/year)
                  <span
                    className="tooltip"
                    tabIndex={0}
                    aria-label="About degradation models"
                  >
                    ⓘ
                    <span className="tooltip-content">
                      <strong>Model A (used):</strong> applies annual
                      degradation to PPA-covered units.
                      <br />
                      <strong>Model B (info only):</strong> apply degradation to
                      kW output and recompute coverage.
                    </span>
                  </span>
                </>
              }
              type="number"
              min="0"
              max="3"
              step="0.1"
              value={inputs.degradation}
              onChange={(e) => onChange('degradation', e.target.value)}
              onBlur={() => onBlur('degradation')}
              error={touched.degradation && errors.degradation}
              helper="Typical range 0.3%–1.0%."
            />
            <Field
              id="years"
              label="PPA Contract Period (years)"
              type="number"
              min="1"
              max="25"
              step="1"
              value={inputs.years}
              onChange={(e) => onChange('years', e.target.value)}
              onBlur={() => onBlur('years')}
              error={touched.years && errors.years}
              helper="Contract term in whole years."
            />
          </div>

          {/* Read-only auto fields */}
          <div className="auto-grid">
            <Readonly
              label="Units per Day (kWh/day)"
              value={nf1.format(auto.unitsPerDay)}
              helper="Units per Month ÷ 30 (30-day month)."
            />
            <Readonly
              label="Current Utility Cost per Unit (₹/kWh)"
              value={inr2.format(auto.utilityRate || 0)}
              helper="Monthly Bill ÷ Units per Month."
            />
            <Readonly
              label="Recommended Solar System Size (kW)"
              value={`${nf1.format(auto.kWNeeded)} kW`}
              helper="Estimation based on Avg Generation per kW per day."
            />
          </div>

          {/* Alerts */}
          {results.negativeNow && (
            <div className="alert danger" role="alert">
              No savings at this PPA rate — Monthly Savings is negative.
            </div>
          )}
          {!results.negativeNow && results.warnHigher && (
            <div className="alert warn" role="alert">
              Warning: Monthly PPA Bill is greater than or equal to Current
              Monthly Bill.
            </div>
          )}
          {hasErrors && (
            <div className="alert info" role="alert">
              Please fix the highlighted fields to enable{' '}
              <strong>Calculate</strong>.
            </div>
          )}
        </section>

        {/* Results: System Sizing */}
        <section className="card">
          <h2>System Sizing</h2>
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi-label">Recommended Size</div>
              <div className="kpi-value">{nf1.format(auto.kWNeeded)} kW</div>
              <div className="kpi-help">
                Based on site yield of {nf1.format(inputs.avgGen)} kWh/kW/day.
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Units per Day</div>
              <div className="kpi-value">
                {nf1.format(auto.unitsPerDay)} kWh
              </div>
              <div className="kpi-help">Consumption estimate.</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Utility Rate</div>
              <div className="kpi-value">
                {inr2.format(auto.utilityRate || 0)}/kWh
              </div>
              <div className="kpi-help">Current effective tariff.</div>
            </div>
          </div>
        </section>

        {/* Results: Monthly Snapshot */}
        <section className="card">
          <h2>Monthly Snapshot</h2>
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi-label">Current Monthly Bill</div>
              <div className="kpi-value">
                {inr0.format(Math.max(0, inputs.monthlyBill))}
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Monthly PPA Bill (Year 1)</div>
              <div className="kpi-value">
                {inr0.format(Math.max(0, results.monthlyPPA))}
              </div>
              <div className="kpi-help">
                PPA Rate: {inr2.format(Math.max(0.1, inputs.ppaRate))}/kWh
              </div>
            </div>
            <div className={`kpi ${results.negativeNow ? 'neg' : 'pos'}`}>
              <div className="kpi-label">Monthly Savings</div>
              <div className="kpi-value">
                {inr0.format(Math.round(results.monthlySavings))}
              </div>
            </div>
          </div>

          {/* Bar chart */}
          <div className="chart-card">
            <h3>Monthly: Utility vs PPA (Year 1)</h3>
            <div
              className="chart-wrap"
              role="img"
              aria-label="Bar chart of current monthly bill vs PPA monthly bill"
            >
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={monthlyBarData} barSize={44} barGap={12}>
                  <defs>
                    <linearGradient id="billGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor="#5aa1ff"
                        stopOpacity="0.95"
                      />
                      <stop
                        offset="100%"
                        stopColor="#5aa1ff"
                        stopOpacity="0.55"
                      />
                    </linearGradient>
                    <linearGradient id="ppaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor="#6be7b0"
                        stopOpacity="0.95"
                      />
                      <stop
                        offset="100%"
                        stopColor="#6be7b0"
                        stopOpacity="0.55"
                      />
                    </linearGradient>
                  </defs>

                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="#23304e"
                  />
                  <XAxis
                    dataKey="name"
                    tick={{ fill: '#cdd6f6', fontSize: 12 }}
                    axisLine={{ stroke: '#2a3657' }}
                    tickLine={{ stroke: '#2a3657' }}
                  />
                  <YAxis
                    tickFormatter={(v) => inr0.format(v)}
                    tick={{ fill: '#cdd6f6', fontSize: 12 }}
                    axisLine={{ stroke: '#2a3657' }}
                    tickLine={{ stroke: '#2a3657' }}
                  />
                  <RTooltip content={<MonthlyTooltip />} />
                  <Legend
                    wrapperStyle={{ color: '#d7e1ff' }}
                    iconType="circle"
                    verticalAlign="bottom"
                    height={28}
                  />
                  <Bar
                    dataKey="Utility"
                    name="Utility Bill"
                    fill="url(#billGrad)"
                    radius={[10, 10, 0, 0]}
                    isAnimationActive={true}
                  />
                  <Bar
                    dataKey="PPA"
                    name="PPA Bill"
                    fill="url(#ppaGrad)"
                    radius={[10, 10, 0, 0]}
                    isAnimationActive={true}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        {/* Results: Yearly Snapshot */}
        <section className="card">
          <h2>Yearly Snapshot (Year 1)</h2>
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi-label">Yearly PPA Bill</div>
              <div className="kpi-value">
                {inr0.format(Math.round(results.yearlyPPA1))}
              </div>
            </div>
            <div
              className={`kpi ${results.yearlySavings1 < 0 ? 'neg' : 'pos'}`}
            >
              <div className="kpi-label">Yearly Savings</div>
              <div className="kpi-value">
                {inr0.format(Math.round(results.yearlySavings1))}
              </div>
            </div>
          </div>

          {/* Line chart */}
          <div className="chart-card">
            <h3>Yearly Savings over Contract (with degradation)</h3>
            <div
              className="chart-wrap"
              role="img"
              aria-label="Line chart of yearly savings over the contract period"
            >
              <ResponsiveContainer width="100%" height={340}>
                <LineChart
                  data={lineData}
                  margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
                >
                  <defs>
                    <linearGradient
                      id="savingsStroke"
                      x1="0"
                      y1="0"
                      x2="1"
                      y2="0"
                    >
                      <stop offset="0%" stopColor="#6be7b0" />
                      <stop offset="100%" stopColor="#5aa1ff" />
                    </linearGradient>
                  </defs>

                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="#23304e"
                  />
                  <XAxis
                    dataKey="name"
                    label={{
                      value: 'Year',
                      position: 'insideBottom',
                      offset: -4,
                      fill: '#9fb0df',
                    }}
                    tick={{ fill: '#cdd6f6', fontSize: 12 }}
                    axisLine={{ stroke: '#2a3657' }}
                    tickLine={{ stroke: '#2a3657' }}
                  />
                  <YAxis
                    tickFormatter={(v) => inr0.format(v)}
                    tick={{ fill: '#cdd6f6', fontSize: 12 }}
                    axisLine={{ stroke: '#2a3657' }}
                    tickLine={{ stroke: '#2a3657' }}
                  />
                  <RTooltip content={<LineTooltip />} />
                  <Legend
                    wrapperStyle={{ color: '#d7e1ff' }}
                    iconType="line"
                    verticalAlign="bottom"
                    height={28}
                  />
                  <Line
                    type="monotone"
                    dataKey="Savings"
                    name="Savings"
                    stroke="url(#savingsStroke)"
                    strokeWidth={3}
                    dot={{ r: 3, stroke: '#1c2a4a', strokeWidth: 2 }}
                    activeDot={{ r: 6 }}
                    isAnimationActive={true}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        {/* Contract Summary */}
        <section className="card">
          <h2>Contract Summary</h2>
          <div className="summary-grid">
            <div className="sum-item">
              <div className="sum-label">Contract Term</div>
              <div className="sum-value">{inputs.years} years</div>
            </div>
            <div className="sum-item">
              <div className="sum-label">Total Savings over Contract</div>
              <div className="sum-value">
                {inr0.format(Math.round(results.totalSavings))}
              </div>
            </div>
            <div className="sum-item">
              <div className="sum-label">Average Yearly Savings</div>
              <div className="sum-value">
                {inr0.format(Math.round(results.avgYearly))}
              </div>
            </div>
            <div className="sum-note">
              Savings use <strong>Model A</strong> with{' '}
              {nf1.format(inputs.degradation)}%/yr degradation on covered units.
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>Need help? Hover the ⓘ icons for tips.</span>
      </footer>
    </div>
  );
}
