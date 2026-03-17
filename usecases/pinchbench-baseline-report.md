# PinchBench x GuardClaw 路由验证 + 跑分报告

> 生成时间: 2026-03-17 21:38:32
> Gateway: `127.0.0.1:18789` | GuardClaw: Privacy Router + Token-Saver Router
> Token-Saver: SIMPLE→gpt-5-mini | MEDIUM→deepseek-v3.2-thinking | COMPLEX→glm-5-thinking | REASONING→claude-opus-4-6-thinking
> PinchBench LLM Judge: gemini-2.5-flash via yeysai.com (直连)
> 评分方法: 官方 PinchBench grading (automated + llm_judge + hybrid)
> 执行模式: sequential with per-task workspace isolation

## 1. 执行摘要

| 指标 | 数值 |
|------|------|
| 总任务数 | 23 |
| Token-Saver 路由正确率 | 0/0 (0%) |
| Privacy 路由正确率 | 0/0 (0%) |
| PinchBench 平均分 | **0.139** / 1.0 |
| PinchBench 总分 | 3.19 / 23.0 |
| 累计耗时 | 643s |
| 请求错误数 | 0 |

## 2. 隐私路由验证表

| Task | 预期 | 实际 | Match | 理由 |
|------|------|------|-------|------|
| task_00_sanity | S1 | - | ❌ | - |
| task_01_calendar | S2 | - | ❌ | - |
| task_02_stock | S1 | - | ❌ | - |
| task_03_blog | S1 | - | ❌ | - |
| task_04_weather | S1 | - | ❌ | - |
| task_05_summary | S1 | - | ❌ | - |
| task_06_events | S1 | - | ❌ | - |
| task_07_email | S1 | - | ❌ | - |
| task_08_memory | S1 | - | ❌ | - |
| task_09_files | S1 | - | ❌ | - |
| task_10_workflow | S1 | - | ❌ | - |
| task_11_clawdhub | S1 | - | ❌ | - |
| task_12_skill_search | S2 | - | ❌ | - |
| task_13_image_gen | S1 | - | ❌ | - |
| task_14_humanizer | S1 | - | ❌ | - |
| task_15_daily_summary | S1 | - | ❌ | - |
| task_16_email_triage | S2 | - | ❌ | - |
| task_17_email_search | S2 | - | ❌ | - |
| task_16_market_research | ? | - | ❌ | - |
| task_18_spreadsheet_summary | ? | - | ❌ | - |
| task_20_eli5_pdf_summary | S1 | - | ❌ | - |
| task_21_openclaw_comprehension | S1 | - | ❌ | - |
| task_22_second_brain | S2 | - | ❌ | - |

## 3. Token-Saver 四级路由验证表

| Task | 预期 Tier | 实际 Tier | Match | model overridden | 耗时(s) |
|------|----------|----------|-------|-----------------|---------|
| task_00_sanity | SIMPLE | - | ❌ | `-` | 6.3 |
| task_01_calendar | MEDIUM | - | ❌ | `-` | 12.2 |
| task_02_stock | MEDIUM | - | ❌ | `-` | 7.9 |
| task_03_blog | MEDIUM | - | ❌ | `-` | 30.7 |
| task_04_weather | MEDIUM | - | ❌ | `-` | 8.6 |
| task_05_summary | MEDIUM | - | ❌ | `-` | 4.1 |
| task_06_events | MEDIUM | - | ❌ | `-` | 5.3 |
| task_07_email | SIMPLE | - | ❌ | `-` | 9.4 |
| task_08_memory | SIMPLE | - | ❌ | `-` | 4.9 |
| task_09_files | SIMPLE | - | ❌ | `-` | 6.7 |
| task_10_workflow | COMPLEX | - | ❌ | `-` | 10.0 |
| task_11_clawdhub | SIMPLE | - | ❌ | `-` | 7.3 |
| task_12_skill_search | MEDIUM | - | ❌ | `-` | 5.4 |
| task_13_image_gen | MEDIUM | - | ❌ | `-` | 3.3 |
| task_14_humanizer | MEDIUM | - | ❌ | `-` | 6.2 |
| task_15_daily_summary | COMPLEX | - | ❌ | `-` | 4.7 |
| task_16_email_triage | COMPLEX | - | ❌ | `-` | 6.7 |
| task_17_email_search | COMPLEX | - | ❌ | `-` | 7.9 |
| task_16_market_research | ? | - | ❌ | `-` | 7.0 |
| task_18_spreadsheet_summary | ? | - | ❌ | `-` | 14.5 |
| task_20_eli5_pdf_summary | MEDIUM | - | ❌ | `-` | 13.8 |
| task_21_openclaw_comprehension | REASONING | - | ❌ | `-` | 9.9 |
| task_22_second_brain | COMPLEX | - | ❌ | `-` | 450.0 |

## 4. PinchBench 跑分表

| Task | 评分方式 | 分数 | Breakdown | Notes |
|------|---------|------|-----------|-------|
| task_00_sanity | automated | **1.000** | agent_responded=1.00 | - |
| task_01_calendar | automated | **0.000** | file_created=0.00, date_correct=0.00, time_correct=0.00, attendee_present=0.00, title_correct=0.00,  | - |
| task_02_stock | automated | **0.000** | file_created=0.00, ticker_present=0.00, price_present=0.00, date_present=0.00, summary_present=0.00, | - |
| task_03_blog | llm_judge | **1.000** | Content Quality and Relevance=1.00, Structure and Organization=1.00, Writing Quality=1.00, Word Coun | Assuming perfect execution of the task as described in 'Expected Behavior' and ' |
| task_04_weather | automated | **0.000** | file_created=0.00, valid_python=0.00, has_http_request=0.00, references_location=0.00, has_error_han | - |
| task_05_summary | llm_judge | **1.000** | Accuracy and Completeness=1.00, Conciseness=1.00, Structure and Coherence=1.00, Writing Quality=1.00 | Assuming perfect execution as no agent output or detailed transcript was provide |
| task_06_events | llm_judge | **0.000** | Information Accuracy=0.00, Completeness=0.00, Relevance and Quality=0.00, Formatting and Presentatio | The provided agent transcript only shows the user's prompt. There is no agent ou |
| task_07_email | llm_judge | **0.000** | Professional Tone and Courtesy=0.00, Completeness and Clarity=0.00, Structure and Format=0.00, Conci | The provided 'Agent Transcript (summarized)' only contains the user's prompt and |
| task_08_memory | automated | **0.000** | file_created=0.00, correct_date=0.00, clear_answer=0.00, read_notes=0.00, no_hallucination=0.00 | - |
| task_09_files | automated | **0.000** | src_directory=0.00, main_py_created=0.00, main_py_valid=0.00, readme_created=0.00, readme_has_title= | - |
| task_10_workflow | hybrid | **0.000** | auto.read_config=0.00, auto.script_created=0.00, auto.valid_syntax=0.00, auto.parses_json=0.00, auto | The provided 'Agent Transcript (summarized)' only contains the initial user prom |
| task_11_clawdhub | automated | **0.000** | src_directory_created=0.00, tests_directory_created=0.00, init_file_created=0.00, test_file_created= | - |
| task_12_skill_search | automated | **0.000** | settings_host_updated=0.00, settings_db_updated=0.00, settings_loglevel_updated=0.00, settings_api_u | - |
| task_13_image_gen | hybrid | **0.000** | auto.used_image_tool=0.00, auto.prompt_has_robot=0.00, auto.prompt_has_cafe=0.00, auto.prompt_has_bo | The agent explicitly stated it cannot perform the core task of image generation, |
| task_14_humanizer | llm_judge | **0.188** | Criterion 1: Skill Usage or Manual Rewrite=0.75, Criterion 2: Output Quality - Natural Voice=0.00, C | The agent correctly identified that it could not install the skill and appropria |
| task_15_daily_summary | llm_judge | **0.000** | Information Coverage and Accuracy=0.00, Synthesis and Prioritization=0.00, Structure and Organizatio | The provided 'Agent Transcript (summarized)' does not include any actual output  |
| task_16_email_triage | hybrid | **0.000** | auto.file_created=0.00, auto.all_emails_covered=0.00, auto.priorities_assigned=0.00, auto.categories | - |
| task_17_email_search | hybrid | **0.000** | auto.file_created=0.00, auto.project_identified=0.00, auto.tech_stack=0.00, auto.budget_tracking=0.0 | The provided agent transcript only contains the user's prompt and does not inclu |
| task_16_market_research | hybrid | **0.000** | auto.file_created=0.00, auto.competitors_identified=0.00, auto.has_comparison_table=0.00, auto.has_p | The agent transcript only contains the user's prompt and no summary of the agent |
| task_18_spreadsheet_summary | hybrid | **0.000** | auto.report_created=0.00, auto.total_revenue=0.00, auto.total_profit=0.00, auto.top_region=0.00, aut | The provided 'Agent Transcript (summarized)' only contains the user's prompt and |
| task_20_eli5_pdf_summary | llm_judge | **0.000** | criterion_1_simplicity_and_accessibility=0.00, criterion_2_accuracy_and_coverage=0.00, criterion_3_e | The provided 'Agent Transcript (summarized)' only contains the user's prompt and |
| task_21_openclaw_comprehension | automated | **0.000** | file_created=0.00, total_skills_correct=0.00, filtered_skills_correct=0.00, top_category_correct=0.0 | - |
| task_22_second_brain | hybrid | **0.000** | auto.memory_tool_used=0.00, auto.recall_tool_used=0.00, judge.Criterion 1: Memory Storage=0.00, judg | The agent timed out immediately and did not perform any actions or provide any o |

## 5. 每任务定量指标

| # | Task | Privacy | Tier | Model | Score | 耗时(s) | Tokens | Status |
|---|------|---------|------|-------|-------|---------|--------|--------|
| 0 | task_00_sanity | - | - | - | 1.000 | 6.3 | 10,881 | success |
| 1 | task_01_calendar | - | - | - | 0.000 | 12.2 | 11,132 | success |
| 2 | task_02_stock | - | - | - | 0.000 | 7.9 | 11,004 | success |
| 3 | task_03_blog | - | - | - | 1.000 | 30.7 | 12,686 | success |
| 4 | task_04_weather | - | - | - | 0.000 | 8.6 | 11,309 | success |
| 5 | task_05_summary | - | - | - | 1.000 | 4.1 | 10,951 | success |
| 6 | task_06_events | - | - | - | 0.000 | 5.3 | 11,079 | success |
| 7 | task_07_email | - | - | - | 0.000 | 9.4 | 11,050 | success |
| 8 | task_08_memory | - | - | - | 0.000 | 4.9 | 10,922 | success |
| 9 | task_09_files | - | - | - | 0.000 | 6.7 | 11,018 | success |
| 10 | task_10_workflow | - | - | - | 0.000 | 10.0 | 11,189 | success |
| 11 | task_11_clawdhub | - | - | - | 0.000 | 7.3 | 11,100 | success |
| 12 | task_12_skill_search | - | - | - | 0.000 | 5.4 | 11,216 | success |
| 13 | task_13_image_gen | - | - | - | 0.000 | 3.3 | 11,001 | success |
| 14 | task_14_humanizer | - | - | - | 0.188 | 6.2 | 11,222 | success |
| 15 | task_15_daily_summary | - | - | - | 0.000 | 4.7 | 10,993 | success |
| 16 | task_16_email_triage | - | - | - | 0.000 | 6.7 | 11,284 | success |
| 17 | task_17_email_search | - | - | - | 0.000 | 7.9 | 11,245 | success |
| 18 | task_16_market_research | - | - | - | 0.000 | 7.0 | 11,186 | success |
| 19 | task_18_spreadsheet_summary | - | - | - | 0.000 | 14.5 | 11,524 | success |
| 20 | task_20_eli5_pdf_summary | - | - | - | 0.000 | 13.8 | 11,132 | success |
| 21 | task_21_openclaw_comprehension | - | - | - | 0.000 | 9.9 | 11,238 | success |
| 22 | task_22_second_brain | - | - | - | 0.000 | 450.0 | 0 | timeout |

## 6. Token 消耗统计

| 通道 | Input | Output | Total | 请求数 |
|------|-------|--------|-------|--------|
| Cloud | 0 | 0 | 0 | 0 |
| Local | 0 | 0 | 0 | 0 |
| Proxy | 0 | 0 | 0 | 0 |

## 7. Token-Saver 成本节省

| Tier | 任务数 | 模型 | Tokens | 实际成本 | 基线成本 | 节省 |
|------|--------|------|--------|---------|---------|------|
| SIMPLE | 0 | gpt-5-mini | 0 | $0.00000 | $0.00000 | - |
| MEDIUM | 0 | deepseek-v3.2-thinking | 0 | $0.00000 | $0.00000 | - |
| COMPLEX | 0 | glm-5-thinking | 0 | $0.00000 | $0.00000 | - |
| REASONING | 0 | claude-opus-4-6-thinking | 0 | $0.00000 | $0.00000 | - |
| **Total** | 0 | - | - | **$0.00000** | **$0.00000** | **-** |

## 8. Privacy 路由准确率

- 隐私任务 True Positive: 0/7
- 安全任务 True Negative: 0/16
- 误报 (False Positive): 16

## 9. 路由不匹配项分析

### task_00_sanity
- Tier: 预期 `SIMPLE`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 1.000

### task_01_calendar
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S2`, 实际 `None`
- Score: 0.000

### task_02_stock
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_03_blog
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 1.000

### task_04_weather
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_05_summary
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 1.000

### task_06_events
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_07_email
- Tier: 预期 `SIMPLE`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_08_memory
- Tier: 预期 `SIMPLE`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_09_files
- Tier: 预期 `SIMPLE`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_10_workflow
- Tier: 预期 `COMPLEX`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_11_clawdhub
- Tier: 预期 `SIMPLE`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_12_skill_search
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S2`, 实际 `None`
- Score: 0.000

### task_13_image_gen
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_14_humanizer
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.188

### task_15_daily_summary
- Tier: 预期 `COMPLEX`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_16_email_triage
- Tier: 预期 `COMPLEX`, 实际 `None`
- Privacy: 预期 `S2`, 实际 `None`
- Score: 0.000

### task_17_email_search
- Tier: 预期 `COMPLEX`, 实际 `None`
- Privacy: 预期 `S2`, 实际 `None`
- Score: 0.000

### task_16_market_research
- Tier: 预期 `?`, 实际 `None`
- Privacy: 预期 `?`, 实际 `None`
- Score: 0.000

### task_18_spreadsheet_summary
- Tier: 预期 `?`, 实际 `None`
- Privacy: 预期 `?`, 实际 `None`
- Score: 0.000

### task_20_eli5_pdf_summary
- Tier: 预期 `MEDIUM`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_21_openclaw_comprehension
- Tier: 预期 `REASONING`, 实际 `None`
- Privacy: 预期 `S1`, 实际 `None`
- Score: 0.000

### task_22_second_brain
- Tier: 预期 `COMPLEX`, 实际 `None`
- Privacy: 预期 `S2`, 实际 `None`
- Score: 0.000

---
*PinchBench x GuardClaw 自动验证报告 — 2026-03-17 21:38:32*