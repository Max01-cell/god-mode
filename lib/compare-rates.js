import processors, { posCompatibility, posLockStatus } from '../rates/processors.js';

// ── Interchange estimation ────────────────────────────────────────────────────
// Blended interchange rates by business type (card-present weighted avg)
const BLENDED_INTERCHANGE = {
  restaurant: 0.0152,
  retail:     0.0155,
  ecommerce:  0.0178,
  services:   0.0160,
  moto:       0.0178,
  default:    0.0158,
};

// Estimated AmEx share of total volume by business type
const AMEX_SHARE = {
  restaurant: 0.10,
  retail:     0.10,
  ecommerce:  0.14,
  services:   0.12,
  default:    0.10,
};

function normalizeBusinessType(raw) {
  if (!raw) return 'default';
  const s = raw.toLowerCase();
  if (/restaurant|cafe|bar|diner|food|bistro|pizza|grill/.test(s)) return 'restaurant';
  if (/retail|store|shop|boutique|hardware|grocery/.test(s))        return 'retail';
  if (/ecommerce|e-commerce|online|web|internet/.test(s))           return 'ecommerce';
  if (/service|salon|spa|clinic|dental|auto|repair/.test(s))        return 'services';
  if (/moto|mail|telephone|order/.test(s))                          return 'moto';
  return 'default';
}

function estimateInterchange(monthly_volume, businessType, cnp_volume_percent = 0) {
  const base_rate = BLENDED_INTERCHANGE[businessType] ?? BLENDED_INTERCHANGE.default;
  if (!cnp_volume_percent || cnp_volume_percent <= 0) {
    return monthly_volume * base_rate;
  }
  // CNP transactions carry ~0.35% higher interchange than card-present
  const cnp_volume = monthly_volume * (cnp_volume_percent / 100);
  const cp_volume  = monthly_volume - cnp_volume;
  return (cp_volume * base_rate) + (cnp_volume * (base_rate + 0.0035));
}

function estimateAmexVolume(monthly_volume, businessType, card_mix) {
  if (card_mix?.amex_percent != null) {
    return monthly_volume * (card_mix.amex_percent / 100);
  }
  return monthly_volume * (AMEX_SHARE[businessType] ?? AMEX_SHARE.default);
}

/**
 * Estimate card network assessment fees (Visa, MC, Discover).
 * Pass-through from card networks — charged on every processor.
 * Visa: 0.14% of volume + FANF $0.0195/txn
 * MC:   0.13% of volume + NABU $0.0195/txn
 * Discover: 0.13% of volume
 */
function estimateAssessmentFees(monthly_volume, transaction_count, amex_volume) {
  const non_amex_volume = monthly_volume - amex_volume;
  const amex_share      = monthly_volume > 0 ? amex_volume / monthly_volume : 0;
  const non_amex_txns   = Math.round(transaction_count * (1 - amex_share));

  // Approximate non-AmEx network share: Visa 62%, MC 35%, Discover 3%
  const visa_volume = non_amex_volume * 0.62;
  const mc_volume   = non_amex_volume * 0.35;
  const disc_volume = non_amex_volume * 0.03;
  const visa_txns   = Math.round(non_amex_txns * 0.62);
  const mc_txns     = Math.round(non_amex_txns * 0.35);

  const visa_fees = visa_volume * 0.0014 + visa_txns * 0.0195;  // 0.14% + FANF
  const mc_fees   = mc_volume   * 0.0013 + mc_txns   * 0.0195;  // 0.13% + NABU
  const disc_fees = disc_volume * 0.0013;                        // 0.13%

  return parseFloat((visa_fees + mc_fees + disc_fees).toFixed(2));
}

// ── Dynamic margin split ──────────────────────────────────────────────────────
// Higher volume = more competitive margin to win the deal
function getMarginSplit(monthlyVolume) {
  if (monthlyVolume >= 75000) {
    return { merchantPercent: 75, ourPercent: 25, tier: 'high', reason: 'High volume merchant — competitive margin to win the deal' };
  }
  if (monthlyVolume >= 25000) {
    return { merchantPercent: 70, ourPercent: 30, tier: 'mid', reason: 'Standard margin' };
  }
  return { merchantPercent: 65, ourPercent: 35, tier: 'low', reason: 'Small volume — higher margin to justify the deal' };
}

// ── Floor cost calculators ────────────────────────────────────────────────────

function kurvFloor(monthly_volume, transaction_count, interchange, amex_volume, assessment_fees) {
  const c = processors.kurv.costs;

  // Split auth fees: AmEx at $0.05, bank card (non-AmEx) at $0.04
  const amex_txns     = monthly_volume > 0 ? Math.round(transaction_count * (amex_volume / monthly_volume)) : 0;
  const non_amex_txns = transaction_count - amex_txns;
  const auth_fees     = amex_txns * c.auth_fee_other_including_amex + non_amex_txns * c.auth_fee_bank_card_ip;

  const bin_sponsorship       = monthly_volume  * c.bin_sponsorship_percent;   // pure pass-through — NOT split
  const avs                   = transaction_count * c.avs_fee;
  const batch_fees            = 30 * c.batch_fee;                              // 30 batches/month
  const tech_compliance       = c.semi_annual_tech_compliance / 6;             // $10 semi-annual → $1.67/mo
  const breach_protection_net = c.monthly_breach_protection * 0.50;            // 50% split → net $3/mo
  // Platinum Club $5/mo — included; verify with Kurv if mandatory
  const monthly_fixed = c.monthly_access_fee + breach_protection_net + c.platinum_club + tech_compliance;

  const floor = interchange + assessment_fees + bin_sponsorship + auth_fees + avs + batch_fees + monthly_fixed;
  return {
    floor: parseFloat(floor.toFixed(2)),
    breakdown: {
      interchange:     parseFloat(interchange.toFixed(2)),
      assessment_fees: parseFloat(assessment_fees.toFixed(2)),
      bin_sponsorship: parseFloat(bin_sponsorship.toFixed(2)),
      auth_fees:       parseFloat(auth_fees.toFixed(2)),
      avs:             parseFloat(avs.toFixed(2)),
      batch_fees:      parseFloat(batch_fees.toFixed(2)),
      monthly_fixed:   parseFloat(monthly_fixed.toFixed(2)),
    },
  };
}

/**
 * Generic EPI floor calculator — works for all six tiers (A-F).
 * Option C is a POS Placement tier — always uses the higher 0.30% AmEx OptBlue placement rate.
 * Option A has minimal fixed fees — $25 monthly minimum is included in floor.
 */
function epiTierFloor(tier_key, monthly_volume, transaction_count, interchange, amex_volume, assessment_fees, is_pos_placement = false) {
  const t = processors.epi.tiers[tier_key];

  // Option C is the POS Placement tier — always use placement AmEx rate
  const is_placement = tier_key === 'option_c' || is_pos_placement;
  const amex_rate = (is_placement && t.amex_optblue_placement_percent)
    ? t.amex_optblue_placement_percent
    : t.amex_optblue_percent;

  const bin_percent     = t.bin_sponsorship_percent ?? t.cbd_bin_percent ?? 0.0002;
  const bin_sponsorship = monthly_volume  * bin_percent;            // pure pass-through — NOT split
  const auth_fees       = transaction_count * t.auth_fee_cygma;    // $0.00 on Cygma for Option A
  const avs             = transaction_count * t.avs_fee;
  const amex_optblue    = amex_volume * amex_rate;

  const monthly_fixed = t.platform_admin_monthly
    + (t.pci_compliance_monthly     ?? 0)
    + (t.regulatory_compliance_monthly ?? 0)
    + (t.account_on_file_monthly    ?? 0)
    + processors.epi.statement_fee_required;                        // $5 required for bonus eligibility

  // Option A has very low fixed fees — $25 monthly minimum will likely apply
  const min_fee = tier_key === 'option_a' ? processors.epi.monthly_minimum_required : 0;

  const floor = interchange + assessment_fees + bin_sponsorship + auth_fees + avs + amex_optblue + monthly_fixed + min_fee;
  return {
    floor: parseFloat(floor.toFixed(2)),
    breakdown: {
      interchange:     parseFloat(interchange.toFixed(2)),
      assessment_fees: parseFloat(assessment_fees.toFixed(2)),
      bin_sponsorship: parseFloat(bin_sponsorship.toFixed(2)),
      auth_fees:       parseFloat(auth_fees.toFixed(2)),
      avs:             parseFloat(avs.toFixed(2)),
      amex_optblue:    parseFloat(amex_optblue.toFixed(2)),
      monthly_fixed:   parseFloat((monthly_fixed + min_fee).toFixed(2)),
    },
  };
}

/**
 * Beacon Payments — CardConnect platform (primary option).
 * Flex Sell (Clover merchants): handled via is_clover_merchant flag in compareRates.
 */
function beaconCardConnectFloor(monthly_volume, transaction_count, interchange, amex_volume, assessment_fees) {
  const c = processors.beacon.platforms.cardconnect.costs;
  const b = processors.beacon.bonuses;

  const bin_sponsorship = monthly_volume  * c.bin_sponsorship_percent;  // pure pass-through — NOT split
  const auth_fees       = transaction_count * c.auth_fee_bankcard;
  const avs             = transaction_count * c.avs_fee;
  const batch_fees      = 30 * c.batch_fee;
  const amex_optblue    = amex_volume * c.amex_optblue_bin_sponsorship;
  // TransArmor $5 + platform fee $5 = $10 actual costs. Enforce $30 monthly minimum.
  const raw_monthly_fixed = c.transarmor_monthly + c.monthly_platform_fee;
  const monthly_fixed     = Math.max(raw_monthly_fixed, b.requires_monthly_minimum);

  const floor = interchange + assessment_fees + bin_sponsorship + auth_fees + avs + batch_fees + amex_optblue + monthly_fixed;
  return {
    floor: parseFloat(floor.toFixed(2)),
    breakdown: {
      interchange:     parseFloat(interchange.toFixed(2)),
      assessment_fees: parseFloat(assessment_fees.toFixed(2)),
      bin_sponsorship: parseFloat(bin_sponsorship.toFixed(2)),
      auth_fees:       parseFloat(auth_fees.toFixed(2)),
      avs:             parseFloat(avs.toFixed(2)),
      batch_fees:      parseFloat(batch_fees.toFixed(2)),
      amex_optblue:    parseFloat(amex_optblue.toFixed(2)),
      monthly_fixed:   parseFloat(monthly_fixed.toFixed(2)),
    },
  };
}

/**
 * Beacon Payments — TSYS/Payarc platform (secondary / fallback option).
 * WARNING: PCI non-validation $29.95/mo after 60 days; proactive security $49.95/mo after 180 days.
 * Help merchant complete PCI SAQ immediately upon boarding.
 */
function beaconTsysPayarcFloor(monthly_volume, transaction_count, interchange, amex_volume, assessment_fees) {
  const c = processors.beacon.platforms.tsys_payarc.costs;
  const b = processors.beacon.bonuses;

  const bin_sponsorship = monthly_volume  * c.bin_sponsorship_percent;  // pure pass-through — NOT split
  const auth_fees       = transaction_count * c.auth_fee;
  const avs             = transaction_count * c.avs_fee;
  const batch_fees      = 30 * c.batch_close_fee;
  const amex_optblue    = amex_volume * c.amex_optblue;
  const raw_monthly_fixed = c.monthly_customer_service + c.pci_compliance_monthly;
  const monthly_fixed     = Math.max(raw_monthly_fixed, b.requires_monthly_minimum);

  const floor = interchange + assessment_fees + bin_sponsorship + auth_fees + avs + batch_fees + amex_optblue + monthly_fixed;
  return {
    floor: parseFloat(floor.toFixed(2)),
    breakdown: {
      interchange:     parseFloat(interchange.toFixed(2)),
      assessment_fees: parseFloat(assessment_fees.toFixed(2)),
      bin_sponsorship: parseFloat(bin_sponsorship.toFixed(2)),
      auth_fees:       parseFloat(auth_fees.toFixed(2)),
      avs:             parseFloat(avs.toFixed(2)),
      batch_fees:      parseFloat(batch_fees.toFixed(2)),
      amex_optblue:    parseFloat(amex_optblue.toFixed(2)),
      monthly_fixed:   parseFloat(monthly_fixed.toFixed(2)),
    },
    pci_risk_note: 'PCI non-validation: $29.95/mo after 60 days. Proactive security: $49.95/mo after 180 days. Complete PCI SAQ immediately.',
  };
}

// ── Margin strategy ───────────────────────────────────────────────────────────
// BIN sponsorship and assessments are pass-through — NOT included in gross margin.
// Gross margin is computed solely on the savings gap (fees above the floor).

function applyMargin(floorCost, currentFees, merchantPercent, ourPercent) {
  const savings_gap      = currentFees - floorCost;
  const merchant_savings = parseFloat((savings_gap * (merchantPercent / 100)).toFixed(2));
  const our_gross_margin = parseFloat((savings_gap * (ourPercent   / 100)).toFixed(2));
  const proposed_fees    = parseFloat((currentFees - merchant_savings).toFixed(2));
  return { savings_gap: parseFloat(savings_gap.toFixed(2)), merchant_savings, our_gross_margin, proposed_fees };
}

// ── Upfront bonus calculations ────────────────────────────────────────────────

function beaconUpfrontBonus(monthly_residual) {
  const b = processors.beacon.bonuses;
  const multiplier_result = Math.min(monthly_residual * b.multiplier, b.multiplier_cap);
  return parseFloat(Math.max(b.advance_per_account, multiplier_result).toFixed(2));
}

function epiUpfrontBonus(monthly_residual, tier_key) {
  const t = processors.epi.tiers[tier_key];
  const activation      = t.activation_bonus ?? 0;
  const multiplier      = t.multiplier ?? 0;
  const cap             = t.multiplier_cap ?? 0;
  const multiplier_bonus = multiplier > 0 ? Math.min(monthly_residual * multiplier, cap) : 0;
  return parseFloat((activation + multiplier_bonus).toFixed(2));
}

// ── Debit savings highlight ───────────────────────────────────────────────────

function estimateDebitSavings(monthly_volume, transaction_count, current_fees, card_mix) {
  const debit_percent = card_mix?.debit_percent ?? 40;  // default 40% if not on statement
  const debit_volume  = monthly_volume * (debit_percent / 100);
  const avg_ticket    = monthly_volume > 0 && transaction_count > 0
    ? monthly_volume / transaction_count : 85;
  const debit_transactions = Math.round(debit_volume / avg_ticket);

  // Current cost: assume merchant's effective rate applies uniformly to debit volume
  const current_effective  = monthly_volume > 0 ? current_fees / monthly_volume : 0;
  const current_debit_cost = parseFloat((debit_volume * current_effective).toFixed(2));

  // Interchange-plus debit cost: regulated Durbin debit 0.05% + $0.21/txn
  // Plus rough interchange-plus markup (~0.20% + $0.05/txn on our side)
  const regulated_rate     = 0.0005;   // 0.05% Durbin-regulated
  const regulated_per_txn  = 0.21;     // $0.21/txn
  const our_markup_rate    = 0.002;    // ~0.20% our markup on debit
  const our_markup_per_txn = 0.05;     // $0.05/txn our markup
  const ip_debit_cost = parseFloat((
    debit_volume * (regulated_rate + our_markup_rate) +
    debit_transactions * (regulated_per_txn + our_markup_per_txn)
  ).toFixed(2));

  const debit_savings = Math.max(0, parseFloat((current_debit_cost - ip_debit_cost).toFixed(2)));

  let debit_savings_note;
  if (debit_savings > 200) {
    debit_savings_note = `Debit cards alone are costing this merchant $${debit_savings.toFixed(0)}/month in excess fees. Flat-rate processors apply the same rate to debit as credit, but regulated debit interchange is only 0.05% + $0.21/txn. This is a major talking point.`;
  } else if (debit_savings > 50) {
    debit_savings_note = `Meaningful debit savings available — $${debit_savings.toFixed(0)}/month. Merchant likely on flat-rate paying full rate on low-cost debit transactions.`;
  } else {
    debit_savings_note = `Debit savings are modest ($${debit_savings.toFixed(0)}/month) — merchant may already be on favorable debit rates or have low debit volume.`;
  }

  return {
    debit_volume:              parseFloat(debit_volume.toFixed(2)),
    debit_transactions,
    debit_percent_used:        debit_percent,
    current_debit_cost,
    interchange_plus_debit_cost: ip_debit_cost,
    debit_savings,
    debit_savings_note,
  };
}

// ── POS compatibility helpers ─────────────────────────────────────────────────

/**
 * Look up the posLockStatus entry for a given POS system string.
 */
function lookupPosStatus(pos_system) {
  const pos = (pos_system ?? '').toLowerCase().trim();
  if (!pos || pos === 'unknown' || pos === "i don't know" || pos === 'not provided') return posLockStatus.standalone_unknown;
  if (/pax/.test(pos))                 return posLockStatus.pax;
  if (/dejavoo/.test(pos))             return posLockStatus.dejavoo;
  if (/verifone/.test(pos))            return posLockStatus.verifone;
  if (/ingenico/.test(pos))            return posLockStatus.ingenico;
  if (/clover/.test(pos))              return posLockStatus.clover;
  if (/square/.test(pos))              return posLockStatus.square;
  if (/toast/.test(pos))               return posLockStatus.toast;
  if (/heartland|genius/.test(pos))    return posLockStatus.heartland_genius;
  if (/spoton/.test(pos))              return posLockStatus.spoton;
  if (/lightspeed/.test(pos))          return posLockStatus.lightspeed;
  if (/revel/.test(pos))               return posLockStatus.revel;
  if (/shopify/.test(pos))             return posLockStatus.shopify_pos;
  if (/stripe.*terminal/.test(pos))    return posLockStatus.stripe_terminal;
  if (/ncr|aloha/.test(pos))           return posLockStatus.ncr_aloha;
  if (/micros|oracle/.test(pos))       return posLockStatus.micros_oracle;
  if (/online|e.?commerce/.test(pos))  return posLockStatus.online_only;
  return posLockStatus.other;
}

/**
 * Determine equipment_action and equipment_notes for a given processor + POS combination.
 * processor_key: 'kurv' | 'epi' | 'beacon'
 */
function getEquipmentDetails(processor_key, pos_system, hardware_preference) {
  const pos    = (pos_system ?? '').toLowerCase();
  const posInfo = lookupPosStatus(pos_system);
  const pc     = posCompatibility[processor_key];
  const compatible = posInfo.compatible_processors.includes(processor_key);

  // Clover + Beacon: keep existing hardware
  if (/clover/.test(pos) && processor_key === 'beacon') {
    return {
      equipment_action: 'keep_clover',
      equipment_notes:  'Keep existing Clover hardware. Beacon processes via CardConnect native Clover integration. $5/mo platform fee applies.',
    };
  }

  // Reprogrammable terminal that works with this processor
  if (!posInfo.locked && compatible) {
    return {
      equipment_action: 'reprogram_existing',
      equipment_notes:  `Reprogram existing ${pos_system ?? 'terminal'} to run through ${pc ? processor_key.toUpperCase() : processor_key}. No hardware change needed.`,
    };
  }

  // Merchant wants to keep hardware but processor is not compatible
  if (hardware_preference === 'keep_hardware') {
    return {
      equipment_action: 'not_compatible',
      equipment_notes:  `${pos_system ?? 'Current POS'} is ${posInfo.locked ? 'locked to its own processing' : 'not compatible with this processor'}. ${posInfo.notes}`,
    };
  }

  // Merchant is open to switching or has locked POS with enough savings
  if (!pos_system) {
    return {
      equipment_action: 'provide_free_terminal',
      equipment_notes:  pc ? `Free terminal provided. ${pc.notes}` : 'Free terminal provided.',
    };
  }

  if (pc?.free_pos_available && pc.proprietary_pos) {
    return {
      equipment_action: 'provide_free_pos',
      equipment_notes:  `Replace ${pos_system} with free ${pc.proprietary_pos}. ${pc.notes}`,
    };
  }
  return {
    equipment_action: 'provide_free_terminal',
    equipment_notes:  `Replace ${pos_system} with free terminal. ${pc?.notes ?? ''}`.trim(),
  };
}

// ── POS system routing ────────────────────────────────────────────────────────

function posSystemRouting(pos_system, best_merchant_savings) {
  const pos     = (pos_system ?? '').toLowerCase().trim();
  const posInfo = lookupPosStatus(pos_system);

  if (!pos || pos === 'unknown' || pos === "i don't know" || pos === 'other' || pos === 'not provided') {
    return { pos_compatible: null, pos_locked: false, pos_recommendation: 'POS system unknown — verify equipment compatibility before closing', equipment_action: 'verify', negotiate_existing: false, preferred_processor: null, deal_difficulty_factor: 'unknown', compatible_processors: posInfo.compatible_processors };
  }
  if (/pax/.test(pos)) {
    return { pos_compatible: true, pos_locked: false, pos_recommendation: 'Merchant uses Pax — can reprogram existing terminal, no hardware change needed', equipment_action: 'reprogram', negotiate_existing: false, preferred_processor: null, deal_difficulty_factor: 'easy', compatible_processors: posInfo.compatible_processors };
  }
  if (/dejavoo/.test(pos)) {
    return { pos_compatible: true, pos_locked: false, pos_recommendation: 'Merchant uses Dejavoo — can reprogram existing terminal', equipment_action: 'reprogram', negotiate_existing: false, preferred_processor: null, deal_difficulty_factor: 'easy', compatible_processors: posInfo.compatible_processors };
  }
  if (/verifone/.test(pos)) {
    return { pos_compatible: true, pos_locked: false, pos_recommendation: 'Merchant uses Verifone — can reprogram existing terminal', equipment_action: 'reprogram', negotiate_existing: false, preferred_processor: null, deal_difficulty_factor: 'easy', compatible_processors: posInfo.compatible_processors };
  }
  if (/ingenico/.test(pos)) {
    return { pos_compatible: true, pos_locked: false, pos_recommendation: 'Merchant uses Ingenico — can reprogram existing terminal', equipment_action: 'reprogram', negotiate_existing: false, preferred_processor: null, deal_difficulty_factor: 'easy', compatible_processors: posInfo.compatible_processors };
  }
  if (/clover/.test(pos)) {
    return { pos_compatible: true, pos_locked: false, pos_recommendation: 'Merchant uses Clover — Beacon only. Beacon Flex Sell at 50% split, no advance bonus. Kurv uses MaxxPay (does not support Clover). EPI does not natively support Clover.', equipment_action: 'keep', negotiate_existing: false, preferred_processor: 'Beacon Payments', deal_difficulty_factor: 'easy', compatible_processors: posInfo.compatible_processors };
  }
  if (/square/.test(pos)) {
    return { pos_compatible: false, pos_locked: true, pos_recommendation: 'Merchant on Square — must switch hardware. Options: Beacon (Clover via Flex Sell), EPI (Exatouch), Kurv (MaxxPay). Highlight savings from eliminating Square flat rate vs interchange-plus.', equipment_action: 'replace', negotiate_existing: false, preferred_processor: null, deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
  }
  if (/toast/.test(pos)) {
    const threshold = 400;
    if (best_merchant_savings != null && best_merchant_savings < threshold) {
      return { pos_compatible: false, pos_locked: true, pos_recommendation: `Savings ($${best_merchant_savings}/mo) may not justify switching from Toast ($${threshold}/mo threshold). Consider helping merchant negotiate with Toast directly.`, equipment_action: 'negotiate existing', negotiate_existing: true, preferred_processor: null, deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
    }
    return { pos_compatible: false, pos_locked: true, pos_recommendation: 'Merchant on Toast — savings justify switch. Hardware options: Beacon (Clover via Flex Sell), EPI (Exatouch), Kurv (MaxxPay).', equipment_action: 'replace', negotiate_existing: false, preferred_processor: 'Beacon Payments', deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
  }
  if (/heartland|genius/.test(pos)) {
    const threshold = 500;
    if (best_merchant_savings != null && best_merchant_savings < threshold) {
      return { pos_compatible: false, pos_locked: true, pos_recommendation: `Merchant on Heartland Genius — locked. Savings ($${best_merchant_savings}/mo) below $${threshold}/mo threshold. Recommend negotiating with Heartland directly.`, equipment_action: 'negotiate existing', negotiate_existing: true, preferred_processor: null, deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
    }
    return { pos_compatible: false, pos_locked: true, pos_recommendation: 'Merchant on Heartland Genius — locked. Savings exceed $500/mo threshold. Hardware options: Beacon (Clover via Flex Sell), EPI (Exatouch), Kurv (MaxxPay).', equipment_action: 'replace', negotiate_existing: false, preferred_processor: 'Beacon Payments', deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
  }
  if (/spoton/.test(pos)) {
    const threshold = 400;
    if (best_merchant_savings != null && best_merchant_savings < threshold) {
      return { pos_compatible: false, pos_locked: true, pos_recommendation: `Savings ($${best_merchant_savings}/mo) may not justify switching from SpotOn ($${threshold}/mo threshold). Consider negotiating with SpotOn.`, equipment_action: 'negotiate existing', negotiate_existing: true, preferred_processor: null, deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
    }
    return { pos_compatible: false, pos_locked: true, pos_recommendation: 'Merchant on SpotOn — savings justify switch. Hardware options: Beacon (Clover via Flex Sell), EPI (Exatouch), Kurv (MaxxPay).', equipment_action: 'replace', negotiate_existing: false, preferred_processor: null, deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
  }
  if (/shopify|lightspeed|revel/.test(pos)) {
    return { pos_compatible: false, pos_locked: true, pos_recommendation: `Merchant on ${pos_system} — bundled POS. More involved to switch. Show the numbers and let savings make the case. Hardware if switching: Beacon (Clover via Flex Sell), EPI (Exatouch), Kurv (MaxxPay).`, equipment_action: 'replace', negotiate_existing: false, preferred_processor: null, deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
  }
  if (/ncr|aloha|micros|oracle/.test(pos)) {
    const threshold = 500;
    if (best_merchant_savings != null && best_merchant_savings < threshold) {
      return { pos_compatible: false, pos_locked: true, pos_recommendation: `${pos_system} — legacy enterprise POS, locked. Savings ($${best_merchant_savings}/mo) below threshold. Recommend complex migration only if merchant is motivated.`, equipment_action: 'negotiate existing', negotiate_existing: true, preferred_processor: null, deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
    }
    return { pos_compatible: false, pos_locked: true, pos_recommendation: `${pos_system} — legacy enterprise POS, locked. Complex migration required. Options: Beacon (Clover via Flex Sell), EPI (Exatouch), Kurv (MaxxPay).`, equipment_action: 'replace', negotiate_existing: false, preferred_processor: 'Beacon Payments', deal_difficulty_factor: 'hard', compatible_processors: posInfo.compatible_processors };
  }
  return { pos_compatible: null, pos_locked: false, pos_recommendation: `POS system "${pos_system}" — verify equipment compatibility before closing. ${posInfo.notes}`, equipment_action: 'verify', negotiate_existing: false, preferred_processor: null, deal_difficulty_factor: 'unknown', compatible_processors: posInfo.compatible_processors };
}

// ── Volume tier ───────────────────────────────────────────────────────────────

function volumeTier(monthly_volume) {
  if (monthly_volume < 10000)  return 'Less than $10,000';
  if (monthly_volume < 25000)  return '$10,000 - $25,000';
  if (monthly_volume < 50000)  return '$25,000 - $50,000';
  if (monthly_volume < 100000) return '$50,000 - $100,000';
  return '$100,000+';
}

function volumeNote(tier, options) {
  const epiA = options.find(o => o.tier.includes('Option A'));
  const kurv = options.find(o => o.processor === 'Kurv (EMS)');

  if (tier === 'Less than $10,000') {
    return { preferred_processor: epiA ?? null, note: 'Low volume merchant — EPI Option A zero auth fee recommended. Verify minimum fee requirements.' };
  }
  if (tier === '$100,000+') {
    return { preferred_processor: kurv ?? null, note: 'Enterprise volume — Kurv 80% residual split is the long-term play. EPI Option A zero auth fee also strong if transaction count is very high.' };
  }
  if (tier === '$50,000 - $100,000') {
    return { preferred_processor: kurv ?? null, note: 'High volume — Kurv 80% split very attractive for long-term residual. Beacon Flex Sell qualifies for 1-2 free POS stations.' };
  }
  if (tier === '$25,000 - $50,000') {
    return { preferred_processor: null, note: 'Mid-tier merchant — all processors competitive. Beacon Flex Sell qualifies for free handheld or mini POS.' };
  }
  return { preferred_processor: null, note: 'Small-mid merchant — EPI or Kurv both solid. Beacon Flex Sell may not qualify for free POS at this volume.' };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compare Kurv, all 6 EPI tiers, and Beacon (CardConnect primary, TSYS secondary).
 * Applies POS routing, volume tier logic, dynamic margin split, CNP interchange adjustment,
 * and debit savings highlight. Merchant email shows single best option; owner email shows top 5.
 *
 * @param {object} statementData - output of analyzeStatement
 * @returns {object} full comparison with processor_comparison, secondary_options, recommendation, routing fields
 */
export function compareRates(statementData) {
  const {
    monthly_volume,
    total_fees: current_fees,
    transaction_count: raw_txn_count,
    business_type: raw_business_type,
    card_mix,
    pos_system         = null,
    cnp_volume_percent = 0,   // % of volume that is keyed/MOTO/CNP — boosts interchange estimate
    pricing_model      = null, // flat_rate | tiered | interchange_plus
    hardware_preference = null, // keep_hardware | open_to_switch | wants_new
  } = statementData;

  if (!monthly_volume || monthly_volume <= 0) {
    throw new Error('Cannot compare rates: monthly_volume is required');
  }
  if (!current_fees || current_fees <= 0) {
    throw new Error('Cannot compare rates: total_fees (current fees) is required');
  }

  const businessType      = normalizeBusinessType(raw_business_type);
  const transaction_count = raw_txn_count && raw_txn_count > 0
    ? raw_txn_count
    : Math.round(monthly_volume / 85);

  const interchange     = estimateInterchange(monthly_volume, businessType, cnp_volume_percent);
  const amex_volume     = estimateAmexVolume(monthly_volume, businessType, card_mix);
  const assessment_fees = estimateAssessmentFees(monthly_volume, transaction_count, amex_volume);

  // Dynamic margin split based on volume
  const split = getMarginSplit(monthly_volume);
  console.log(`[compare-rates] margin split — volume: $${monthly_volume} → ${split.merchantPercent}/${split.ourPercent} (${split.tier} tier)`);

  // Detect Clover merchant — Beacon uses Flex Sell (50% split, no bonus)
  const is_clover_merchant = /clover/.test((pos_system ?? '').toLowerCase());
  // Detect POS replacement — EPI uses higher 0.30% AmEx OptBlue placement rate (Exatouch)
  const pos_lower = (pos_system ?? '').toLowerCase();
  const is_pos_placement = /square|toast|heartland|genius|spoton|shopify|lightspeed|revel/.test(pos_lower);

  // ── Floor costs ────────────────────────────────────────────────────────────
  const kurv_floor    = kurvFloor(monthly_volume, transaction_count, interchange, amex_volume, assessment_fees);
  const beacon_floor  = beaconCardConnectFloor(monthly_volume, transaction_count, interchange, amex_volume, assessment_fees);
  const beacon_t_floor = beaconTsysPayarcFloor(monthly_volume, transaction_count, interchange, amex_volume, assessment_fees);

  const EPI_TIERS = ['option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f'];
  const epi_floors = EPI_TIERS.map(k => epiTierFloor(k, monthly_volume, transaction_count, interchange, amex_volume, assessment_fees, is_pos_placement));

  // ── Margins ────────────────────────────────────────────────────────────────
  const kurv_margin     = applyMargin(kurv_floor.floor,    current_fees, split.merchantPercent, split.ourPercent);
  const beacon_margin   = applyMargin(beacon_floor.floor,  current_fees, split.merchantPercent, split.ourPercent);
  const beacon_t_margin = applyMargin(beacon_t_floor.floor, current_fees, split.merchantPercent, split.ourPercent);
  const epi_margins     = epi_floors.map(f => applyMargin(f.floor, current_fees, split.merchantPercent, split.ourPercent));

  // ── Residuals ──────────────────────────────────────────────────────────────
  const residual_kurv   = parseFloat((kurv_margin.our_gross_margin * processors.kurv.residual_split).toFixed(2));
  const beacon_split_pct = is_clover_merchant
    ? processors.beacon.flex_sell_pos.residual_split
    : processors.beacon.platforms.cardconnect.residual_split;
  const residual_beacon   = parseFloat((beacon_margin.our_gross_margin   * beacon_split_pct).toFixed(2));
  const residual_beacon_t = parseFloat((beacon_t_margin.our_gross_margin * processors.beacon.platforms.tsys_payarc.residual_split).toFixed(2));
  const epi_residuals     = EPI_TIERS.map((k, i) =>
    parseFloat((epi_margins[i].our_gross_margin * processors.epi.tiers[k].residual_split).toFixed(2)));

  // ── Bonuses ────────────────────────────────────────────────────────────────
  const bonus_beacon   = is_clover_merchant ? 0 : beaconUpfrontBonus(residual_beacon);
  const bonus_beacon_t = beaconUpfrontBonus(residual_beacon_t);
  const epi_bonuses    = EPI_TIERS.map((k, i) => epiUpfrontBonus(epi_residuals[i], k));

  const proposed_rate_pct = (fees) => parseFloat(((fees / monthly_volume) * 100).toFixed(2));
  const beacon_tier_label  = is_clover_merchant ? 'Flex Sell — 50% Split (Clover)' : 'CardConnect — 60% Split';

  // ── Build options array ────────────────────────────────────────────────────
  const options = [
    {
      processor:                'Kurv (EMS)',
      tier:                     'Retail 80%',
      floor_cost:               kurv_floor.floor,
      floor_breakdown:          kurv_floor.breakdown,
      proposed_merchant_fees:   kurv_margin.proposed_fees,
      proposed_effective_rate:  proposed_rate_pct(kurv_margin.proposed_fees),
      merchant_monthly_savings: kurv_margin.merchant_savings,
      merchant_annual_savings:  parseFloat((kurv_margin.merchant_savings * 12).toFixed(2)),
      our_gross_margin:         kurv_margin.our_gross_margin,
      our_monthly_residual:     residual_kurv,
      upfront_bonus:            processors.kurv.bonuses.activation_bonus,
      first_year_total_income:  parseFloat((processors.kurv.bonuses.activation_bonus + residual_kurv * 12).toFixed(2)),
      ...getEquipmentDetails('kurv', pos_system, hardware_preference),
    },
    ...EPI_TIERS.map((tier_key, i) => {
      const t = processors.epi.tiers[tier_key];
      return {
        processor:                'EPI',
        tier:                     t.name,
        floor_cost:               epi_floors[i].floor,
        floor_breakdown:          epi_floors[i].breakdown,
        proposed_merchant_fees:   epi_margins[i].proposed_fees,
        proposed_effective_rate:  proposed_rate_pct(epi_margins[i].proposed_fees),
        merchant_monthly_savings: epi_margins[i].merchant_savings,
        merchant_annual_savings:  parseFloat((epi_margins[i].merchant_savings * 12).toFixed(2)),
        our_gross_margin:         epi_margins[i].our_gross_margin,
        our_monthly_residual:     epi_residuals[i],
        upfront_bonus:            epi_bonuses[i],
        first_year_total_income:  parseFloat((epi_bonuses[i] + epi_residuals[i] * 12).toFixed(2)),
        ...getEquipmentDetails('epi', pos_system, hardware_preference),
      };
    }),
    {
      processor:                'Beacon Payments',
      tier:                     beacon_tier_label,
      floor_cost:               beacon_floor.floor,
      floor_breakdown:          beacon_floor.breakdown,
      proposed_merchant_fees:   beacon_margin.proposed_fees,
      proposed_effective_rate:  proposed_rate_pct(beacon_margin.proposed_fees),
      merchant_monthly_savings: beacon_margin.merchant_savings,
      merchant_annual_savings:  parseFloat((beacon_margin.merchant_savings * 12).toFixed(2)),
      our_gross_margin:         beacon_margin.our_gross_margin,
      our_monthly_residual:     residual_beacon,
      upfront_bonus:            bonus_beacon,
      first_year_total_income:  parseFloat((bonus_beacon + residual_beacon * 12).toFixed(2)),
      ...getEquipmentDetails('beacon', pos_system, hardware_preference),
    },
  ];

  // ── Compatible options (used for rankings/recommendation) ─────────────────
  // When merchant wants to keep hardware, only rank processors that are actually
  // compatible with their equipment. Owner email still sees all options.
  const posStatusEntry = lookupPosStatus(pos_system);
  const PROCESSOR_KEY  = { 'Kurv (EMS)': 'kurv', 'EPI': 'epi', 'Beacon Payments': 'beacon' };

  let rankingOptions = options;
  if (hardware_preference === 'keep_hardware' && posStatusEntry.compatible_processors.length > 0) {
    const compatible = options.filter(o => {
      const key = PROCESSOR_KEY[o.processor];
      return key && posStatusEntry.compatible_processors.includes(key);
    });
    if (compatible.length > 0) rankingOptions = compatible;
  } else if (hardware_preference === 'keep_hardware' && posStatusEntry.locked) {
    // Locked POS, merchant wants to keep it — negotiate_existing path; use all options for math
    rankingOptions = options;
  }

  // Secondary options — not ranked against primaries
  const secondary_options = [
    {
      processor:                'Beacon Payments',
      tier:                     'TSYS/Payarc — Secondary Platform',
      note:                     'Use only when CardConnect cannot place the merchant. Complete PCI SAQ immediately to avoid $29.95–$49.95/mo penalty fees.',
      floor_cost:               beacon_t_floor.floor,
      floor_breakdown:          beacon_t_floor.breakdown,
      proposed_merchant_fees:   beacon_t_margin.proposed_fees,
      proposed_effective_rate:  proposed_rate_pct(beacon_t_margin.proposed_fees),
      merchant_monthly_savings: beacon_t_margin.merchant_savings,
      merchant_annual_savings:  parseFloat((beacon_t_margin.merchant_savings * 12).toFixed(2)),
      our_gross_margin:         beacon_t_margin.our_gross_margin,
      our_monthly_residual:     residual_beacon_t,
      upfront_bonus:            bonus_beacon_t,
      first_year_total_income:  parseFloat((bonus_beacon_t + residual_beacon_t * 12).toFixed(2)),
      pci_risk_note:            beacon_t_floor.pci_risk_note,
    },
  ];

  // ── Rankings ───────────────────────────────────────────────────────────────
  // Rankings use rankingOptions (hardware-filtered when merchant wants to keep equipment)
  // Top 5 for owner always uses full options so they see every processor
  const best_for_merchant       = [...rankingOptions].sort((a, b) => b.merchant_monthly_savings - a.merchant_monthly_savings)[0];
  const best_for_agent_longterm = [...rankingOptions].sort((a, b) => b.our_monthly_residual - a.our_monthly_residual)[0];
  const best_for_agent_upfront  = [...rankingOptions].sort((a, b) => b.first_year_total_income - a.first_year_total_income)[0];
  // Top 5 for owner email — sorted by merchant savings (most beneficial to merchant first)
  // Includes all processors (compatible and incompatible) — equipment_action flags each one
  const top5_for_owner = [...options]
    .sort((a, b) => b.merchant_monthly_savings - a.merchant_monthly_savings)
    .slice(0, 5);

  // ── No-savings edge case ───────────────────────────────────────────────────
  const current_effective_rate    = current_fees / monthly_volume;
  const savings_too_low           = best_for_merchant.merchant_monthly_savings < 50;
  const rate_already_competitive  = current_effective_rate < 0.023;
  const no_switch_recommended     = savings_too_low || rate_already_competitive;

  // ── POS routing ────────────────────────────────────────────────────────────
  const posRouting = posSystemRouting(pos_system, best_for_merchant.merchant_monthly_savings);

  // ── Hardware preference overrides ─────────────────────────────────────────
  // Applied after POS routing — merchant's stated preference can expand or constrain options.
  if (hardware_preference === 'keep_hardware') {
    const pos_hw = (pos_system ?? '').toLowerCase();
    if (/clover/.test(pos_hw)) {
      // Already routed to Beacon by posSystemRouting — no change needed
    } else if (/pax|dejavoo|verifone|ingenico/.test(pos_hw)) {
      // Reprogrammable terminals — all processors compatible, no constraint
    } else if (/square|toast|heartland|genius/.test(pos_hw)) {
      // Merchant wants to keep locked POS — only viable if savings are large enough to justify hardware cost
      if (!posRouting.negotiate_existing && best_for_merchant.merchant_monthly_savings < 500) {
        posRouting.negotiate_existing = true;
        posRouting.pos_locked = true;
        posRouting.pos_recommendation = `Merchant wants to keep their ${pos_system} system. Savings ($${best_for_merchant.merchant_monthly_savings}/mo) are below the $500/mo threshold needed to justify a hardware switch. Recommend negotiating with ${pos_system} directly, or presenting Beacon Flex Sell (free Clover hardware) as an upgrade path if they change their mind.`;
        posRouting.deal_difficulty_factor = 'hard';
      }
    }
  } else if (hardware_preference === 'open_to_switch' || hardware_preference === 'wants_new') {
    // Merchant is willing to change — override any POS-based lock
    posRouting.negotiate_existing = false;
    posRouting.pos_locked = false;
    if (posRouting.deal_difficulty_factor === 'hard') posRouting.deal_difficulty_factor = 'medium';
    if (hardware_preference === 'wants_new') {
      posRouting.pos_recommendation = (posRouting.pos_recommendation ? posRouting.pos_recommendation + ' ' : '')
        + 'Merchant actively wants new equipment — highlight free POS options: Exatouch (EPI), Clover via Flex Sell (Beacon), MaxxPay (Kurv).';
    }
  }

  // ── Volume tier ────────────────────────────────────────────────────────────
  const tier = volumeTier(monthly_volume);
  const { preferred_processor: volPreferred, note: volumeNote_ } = volumeNote(tier, options);

  // ── Recommended option ────────────────────────────────────────────────────
  let recommendedOption = best_for_merchant;
  if (!no_switch_recommended) {
    if (posRouting.negotiate_existing) {
      // no processor recommendation
    } else if (posRouting.preferred_processor) {
      const found = options.find(o => o.processor === posRouting.preferred_processor);
      if (found) recommendedOption = found;
    } else if (volPreferred) {
      recommendedOption = volPreferred;
    }
  }

  let recommended;
  if (no_switch_recommended) {
    recommended = 'no_switch_recommended';
  } else if (posRouting.negotiate_existing) {
    recommended = 'negotiate_existing';
  } else {
    recommended = `${recommendedOption.processor} — ${recommendedOption.tier}`;
  }

  let recommendation_reason;
  if (no_switch_recommended) {
    recommendation_reason = rate_already_competitive
      ? `Merchant's current effective rate (${(current_effective_rate * 100).toFixed(2)}%) is already below 2.3% — switching may not benefit them.`
      : `Best-case savings of $${best_for_merchant.merchant_monthly_savings}/mo falls below $50/mo threshold.`;
  } else if (posRouting.negotiate_existing) {
    recommendation_reason = posRouting.pos_recommendation;
  } else {
    recommendation_reason = `${recommendedOption.processor} — ${recommendedOption.tier}: $${recommendedOption.proposed_merchant_fees}/mo proposed, saving merchant $${recommendedOption.merchant_monthly_savings}/mo ($${recommendedOption.merchant_annual_savings}/yr).`;
  }

  // ── Deal difficulty ────────────────────────────────────────────────────────
  let deal_difficulty;
  if (no_switch_recommended || posRouting.negotiate_existing) {
    deal_difficulty = 'hard';
  } else if (posRouting.deal_difficulty_factor === 'easy') {
    deal_difficulty = 'easy';
  } else if (posRouting.deal_difficulty_factor === 'hard') {
    deal_difficulty = 'hard';
  } else if (posRouting.deal_difficulty_factor === 'medium') {
    deal_difficulty = 'medium';
  } else {
    deal_difficulty = 'medium';
  }

  // ── CNP note ──────────────────────────────────────────────────────────────
  const cnp_note = cnp_volume_percent > 0
    ? `Merchant has ${cnp_volume_percent}% card-not-present volume — interchange costs are higher than card-present estimates. Savings are conservatively estimated; actual results may vary based on CNP mix.`
    : null;

  // ── Debit savings ──────────────────────────────────────────────────────────
  const debit_savings_highlight = estimateDebitSavings(monthly_volume, transaction_count, current_fees, card_mix);

  return {
    processor_comparison: options,
    top5_for_owner,
    secondary_options,
    manual_review_flags: [
      'Verify with Kurv whether Platinum Club ($5/mo) is mandatory for all retail accounts or optional.',
    ],
    recommendation: {
      best_for_merchant:        `${best_for_merchant.processor} — ${best_for_merchant.tier}`,
      best_for_agent_long_term: `${best_for_agent_longterm.processor} — ${best_for_agent_longterm.tier}`,
      best_for_agent_upfront:   `${best_for_agent_upfront.processor} — ${best_for_agent_upfront.tier}`,
      recommended,
      reason: recommendation_reason,
      volume_note: volumeNote_,
    },
    margin_strategy: {
      volume_tier:          split.tier,
      merchant_gets_percent: split.merchantPercent,
      we_keep_percent:      split.ourPercent,
      reason:               split.reason,
    },
    pos_system,
    pos_compatible:        posRouting.pos_compatible,
    pos_locked:            posRouting.pos_locked,
    pos_lock_status:       posStatusEntry.locked ? 'locked' : 'reprogrammable',
    compatible_processors: posRouting.compatible_processors,
    pos_recommendation:    posRouting.pos_recommendation,
    equipment_action:      posRouting.equipment_action,
    volume_tier:           tier,
    deal_difficulty,
    no_switch_recommended,
    cnp_note,
    debit_savings_highlight,
    pricing_model,
    hardware_preference,
    best: no_switch_recommended ? null : recommendedOption,
  };
}
