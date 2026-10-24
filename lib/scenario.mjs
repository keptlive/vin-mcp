import { InputError } from './research.mjs';
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
function number(v,name,min,max,fallback) {
  if (v===undefined && fallback!==undefined) return fallback;
  if (typeof v!=='number' || !Number.isFinite(v) || v<min || v>max) throw new InputError(`${name} must be a number from ${min} to ${max}`);
  return v;
}
export function scenario(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new InputError('Provide a scenario object');
  const price=number(input.price,'price',0,10000000), down=number(input.down_payment,'down_payment',0,price,0);
  const apr=number(input.apr,'apr',0,100), months=number(input.months,'months',1,120);
  if (!Number.isInteger(months)) throw new InputError('months must be a whole number');
  const tax=number(input.tax_amount,'tax_amount',0,10000000,0), fees=number(input.fees,'fees',0,1000000,0);
  const principal=price+tax+fees-down, rate=apr/1200;
  const payment=rate===0?principal/months:principal*rate/(-Math.expm1(-months*Math.log1p(rate)));
  let balance=principal,totalInterest=0;
  const schedule=[];
  for(let month=1;month<=months;month++){
    const interest=balance*rate, paid=month===months?balance+interest:payment;
    balance=Math.max(0,balance-(paid-interest));totalInterest+=interest;
    schedule.push({month,payment:round(paid),interest:round(interest),principal:round(paid-interest),balance:round(balance)});
  }
  const result={kind:'user_assumption_scenario',currency:'USD',assumptions:{price,down_payment:down,apr,months,tax_amount:tax,fees},financing:{principal:round(principal),monthly_payment:round(payment),total_interest:round(totalInterest),total_payments:round(principal+totalInterest)},schedule,notes:['Fixed-rate amortization estimate, not a lender offer.','Taxes and fees are user-supplied amounts, not jurisdiction calculations.','Payment schedule uses unrounded internal balances; lender rounding may differ.']};
  if(input.ownership){
    const o=input.ownership;
    const years=number(o.years,'ownership.years',1,10), miles=number(o.annual_miles,'annual_miles',0,200000);
    if(!Number.isInteger(years))throw new InputError('ownership.years must be a whole number');
    const resale=number(o.resale_value,'resale_value',0,price), insurance=number(o.annual_insurance,'annual_insurance',0,100000), maintenance=number(o.annual_maintenance,'annual_maintenance',0,100000), repairs=number(o.annual_repairs,'annual_repairs',0,100000);
    const energyPrice=number(o.energy_price,'energy_price',0,100), efficiency=number(o.efficiency,'efficiency',0.01,1000);
    if(!['gas','electric'].includes(o.energy_type))throw new InputError('energy_type must be gas or electric');
    const annualEnergy=o.energy_type==='gas'?miles/efficiency*energyPrice:miles/100*efficiency*energyPrice;
    const interestDuring=schedule.slice(0,years*12).reduce((s,x)=>s+x.interest,0);
    const breakdown={depreciation:round(price-resale),energy:round(annualEnergy*years),insurance:round(insurance*years),maintenance:round(maintenance*years),repairs:round(repairs*years),taxes_and_fees:round(tax+fees),finance_interest:round(interestDuring)};
    const total=round(Object.values(breakdown).reduce((a,b)=>a+b,0));
    result.assumptions.ownership={...o};result.ownership={years,breakdown,total,cost_per_mile:miles?round(total/(years*miles)):null};
    result.notes.push('Ownership cost counts depreciation and interest, not principal payments again. Resale, insurance, maintenance and repairs are your assumptions. Electric efficiency is kWh/100 miles; gas efficiency is MPG. PHEV mixed operation is not modeled.');
  }
  return result;
}
