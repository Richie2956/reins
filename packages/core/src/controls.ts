/**
 * Control mapping: which evidence pack fields satisfy which framework
 * controls. Data only, consumed by buildEvidence and the HTML renderer.
 */
import type { ControlMapping } from './types.js';

export const CONTROLS: ControlMapping[] = [
  {
    framework: 'SOC 2',
    control: 'CC6.1',
    title: 'Logical and physical access controls',
    evidence: ['policy.denials', 'policy.approvals', 'totals.policyChecks', 'configHash'],
    statement: 'Every tool call passes through a policy engine that denies protected paths, blocked commands and denied tools, and routes approval tools to a human before execution.',
  },
  {
    framework: 'SOC 2',
    control: 'CC6.8',
    title: 'Prevention and detection of unauthorised software',
    evidence: ['policy.denials', 'totals.denials', 'configHash'],
    statement: 'Package installation tools are rate limited and blocked command patterns are denied, with each decision recorded in the ledger.',
  },
  {
    framework: 'SOC 2',
    control: 'CC7.2',
    title: 'Monitoring of system components for anomalies',
    evidence: ['ledger.verification', 'totals.usageEvents', 'spendByDay', 'decisions'],
    statement: 'Spend, decisions and policy checks are written to a hash chained ledger whose integrity is verified when the pack is produced.',
  },
  {
    framework: 'SOC 2',
    control: 'CC8.1',
    title: 'Change management',
    evidence: ['modifications', 'totals.modifications'],
    statement: 'File and command modifications made by the agent are logged with the path or command, without content, so changes can be traced to a session.',
  },
  {
    framework: 'ISO 27001:2022',
    control: 'A.5.15',
    title: 'Access control',
    evidence: ['policy.denials', 'policy.approvals', 'totals.policyChecks'],
    statement: 'Access to protected files, tools and spend is governed by declared rules and every decision is retained.',
  },
  {
    framework: 'ISO 27001:2022',
    control: 'A.8.15',
    title: 'Logging',
    evidence: ['ledger.verification', 'totals.usageEvents', 'totals.decisions', 'totals.policyChecks'],
    statement: 'Usage, decisions, policy checks and modifications are logged as append only events with a hash chain that detects alteration.',
  },
  {
    framework: 'ISO 27001:2022',
    control: 'A.8.16',
    title: 'Monitoring activities',
    evidence: ['spendByDay', 'decisions', 'totals.spendUsd'],
    statement: 'Spend is metered per period, tiers step down as the budget falls, and idle loops are detected and slept.',
  },
  {
    framework: 'ISO 27001:2022',
    control: 'A.8.32',
    title: 'Change management',
    evidence: ['modifications', 'totals.modifications'],
    statement: 'Agent initiated changes are recorded in the modification log for review.',
  },
  {
    framework: 'NIST AI RMF 1.0',
    control: 'GOVERN 1.7',
    title: 'Processes for decommissioning and phasing out AI systems',
    evidence: ['decisions', 'totals.decisions'],
    statement: 'The governor stops an agent whose budget has been exhausted beyond the grace period and records the lifecycle transition.',
  },
  {
    framework: 'NIST AI RMF 1.0',
    control: 'MANAGE 2.2',
    title: 'Mechanisms to sustain the value of deployed AI systems',
    evidence: ['spendByDay', 'totals.spendUsd', 'decisions'],
    statement: 'Budget tiers, model substitution and heartbeat multipliers keep the agent within its allocated spend.',
  },
  {
    framework: 'NIST AI RMF 1.0',
    control: 'MANAGE 4.1',
    title: 'Post deployment monitoring plans',
    evidence: ['ledger.verification', 'spendByDay', 'policy.denials'],
    statement: 'Continuous metering and policy enforcement produce a verifiable record for post deployment review.',
  },
  {
    framework: 'EU AI Act',
    control: 'Article 12',
    title: 'Record keeping',
    evidence: ['ledger.verification', 'totals.usageEvents', 'totals.policyChecks', 'modifications'],
    statement: 'Events are automatically recorded over the lifetime of the system in a tamper evident log.',
  },
  {
    framework: 'EU AI Act',
    control: 'Article 14',
    title: 'Human oversight',
    evidence: ['policy.approvals', 'totals.approvals', 'decisions'],
    statement: 'Designated tools require human approval before they run, and the governor can stop or sleep the agent without human intervention.',
  },
];

export const FRAMEWORKS = ['SOC 2', 'ISO 27001:2022', 'NIST AI RMF 1.0', 'EU AI Act'] as const;
