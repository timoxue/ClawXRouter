# PinchBench x GuardClaw 路由验证 + 跑分报告

> 生成时间: 2026-03-17 22:46:57
> Gateway: `127.0.0.1:18789` | GuardClaw: Privacy Router + Token-Saver Router
> Token-Saver: SIMPLE→gpt-5-mini | MEDIUM→deepseek-v3.2-thinking | COMPLEX→glm-5-thinking | REASONING→claude-opus-4-6-thinking
> PinchBench LLM Judge: gemini-2.5-flash via yeysai.com (直连)
> 评分方法: 官方 PinchBench grading (automated + llm_judge + hybrid)
> 执行模式: sequential with per-task workspace isolation

## 1. 执行摘要

| 指标 | 数值 |
|------|------|
| 总任务数 | 23 |
| Token-Saver 路由正确率 | 15/23 (65%) |
| Privacy 路由正确率 | 18/23 (78%) |
| PinchBench 平均分 | **0.350** / 1.0 |
| PinchBench 总分 | 8.04 / 23.0 |
| 累计耗时 | 2239s |
| 请求错误数 | 0 |

## 2. 隐私路由验证表

| Task | 预期 | 实际 | Match | 理由 |
|------|------|------|-------|------|
| task_00_sanity | S1 | S1 | ✅ | - |
| task_01_calendar | S2 | S2 | ✅ | [privacy:w90] The message contains an email address (john@ex |
| task_02_stock | S1 | S1 | ✅ | - |
| task_03_blog | S1 | S1 | ✅ | - |
| task_04_weather | S1 | S1 | ✅ | - |
| task_05_summary | S1 | S1 | ✅ | - |
| task_06_events | S1 | S1 | ✅ | - |
| task_07_email | S1 | S1 | ✅ | - |
| task_08_memory | S1 | S1 | ✅ | - |
| task_09_files | S1 | S1 | ✅ | - |
| task_10_workflow | S1 | S1 | ✅ | - |
| task_11_clawdhub | S1 | S1 | ✅ | - |
| task_12_skill_search | S2 | S1 | ❌ | - |
| task_13_image_gen | S1 | S1 | ✅ | - |
| task_14_humanizer | S1 | S1 | ✅ | - |
| task_15_daily_summary | S1 | S1 | ✅ | - |
| task_16_email_triage | S2 | S2 | ✅ | [privacy:w90] S2 keyword detected: internal |
| task_17_email_search | S2 | S1 | ❌ | - |
| task_16_market_research | ? | S1 | ❌ | - |
| task_18_spreadsheet_summary | ? | S3 | ❌ | [privacy:w90] The message explicitly mentions 'employee expe |
| task_20_eli5_pdf_summary | S1 | S1 | ✅ | - |
| task_21_openclaw_comprehension | S1 | S1 | ✅ | - |
| task_22_second_brain | S2 | S1 | ❌ | - |

## 3. Token-Saver 四级路由验证表

| Task | 预期 Tier | 实际 Tier | Match | model overridden | 耗时(s) |
|------|----------|----------|-------|-----------------|---------|
| task_00_sanity | SIMPLE | SIMPLE | ✅ | `gpt-5-mini` | 11.4 |
| task_01_calendar | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 23.1 |
| task_02_stock | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 39.0 |
| task_03_blog | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 67.0 |
| task_04_weather | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 270.0 |
| task_05_summary | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 360.0 |
| task_06_events | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 450.0 |
| task_07_email | SIMPLE | MEDIUM | ❌ | `minimax-m2.5` | 18.7 |
| task_08_memory | SIMPLE | COMPLEX | ❌ | `kimi-k2.5` | 33.6 |
| task_09_files | SIMPLE | MEDIUM | ❌ | `minimax-m2.5` | 106.7 |
| task_10_workflow | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 73.2 |
| task_11_clawdhub | SIMPLE | MEDIUM | ❌ | `minimax-m2.5` | 180.0 |
| task_12_skill_search | MEDIUM | COMPLEX | ❌ | `kimi-k2.5` | 19.0 |
| task_13_image_gen | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 180.0 |
| task_14_humanizer | MEDIUM | COMPLEX | ❌ | `kimi-k2.5` | 21.9 |
| task_15_daily_summary | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 13.5 |
| task_16_email_triage | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 56.0 |
| task_17_email_search | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 18.9 |
| task_16_market_research | ? | COMPLEX | ❌ | `kimi-k2.5` | 93.2 |
| task_18_spreadsheet_summary | ? | COMPLEX | ❌ | `gemini-2.5-flash` | 15.5 |
| task_20_eli5_pdf_summary | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 60.2 |
| task_21_openclaw_comprehension | REASONING | REASONING | ✅ | `claude-opus-4-6-thinking` | 112.9 |
| task_22_second_brain | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 15.1 |

## 4. PinchBench 跑分表

| Task | 评分方式 | 分数 | Breakdown | Notes |
|------|---------|------|-----------|-------|
| task_00_sanity | automated | **1.000** | agent_responded=1.00 | - |
| task_01_calendar | automated | **0.333** | file_created=1.00, attendee_present=0.00, title_correct=1.00, description_present=0.00, time_correct | - |
| task_02_stock | automated | **1.000** | file_created=1.00, ticker_present=1.00, price_present=1.00, date_present=1.00, summary_present=1.00, | - |
| task_03_blog | llm_judge | **0.750** | Content Quality and Relevance=1.00, Structure and Organization=1.00, Writing Quality=1.00, Word Coun | The agent successfully generated a high-quality, well-structured, and relevant b |
| task_04_weather | automated | **0.000** | file_created=0.00, valid_python=0.00, has_http_request=0.00, references_location=0.00, has_error_han | - |
| task_05_summary | llm_judge | **0.000** | Accuracy and Completeness=0.00, Conciseness=0.00, Structure and Coherence=0.00, Writing Quality=0.00 | The agent failed to execute any tools correctly. It did not read the source docu |
| task_06_events | llm_judge | **0.000** | Information Accuracy=0.00, Completeness=0.00, Relevance and Quality=0.00, Formatting and Presentatio | The agent failed to complete the task. It made numerous basic tool usage errors, |
| task_07_email | llm_judge | **1.000** | Professional Tone and Courtesy=1.00, Completeness and Clarity=1.00, Structure and Format=1.00, Conci | The agent successfully generated a professional, clear, and well-structured emai |
| task_08_memory | automated | **0.000** | file_created=0.00, correct_date=0.00, clear_answer=0.00, read_notes=0.00, no_hallucination=0.00 | - |
| task_09_files | automated | **0.571** | src_directory=0.00, main_py_created=0.00, main_py_valid=0.00, readme_created=1.00, readme_has_title= | - |
| task_10_workflow | hybrid | **0.144** | auto.read_config=0.00, auto.script_created=0.00, auto.valid_syntax=0.00, auto.parses_json=0.00, auto | The agent successfully read the config.json file and correctly extracted the API |
| task_11_clawdhub | automated | **0.857** | src_directory_created=1.00, tests_directory_created=1.00, init_file_created=1.00, test_file_created= | - |
| task_12_skill_search | automated | **0.000** | settings_host_updated=0.00, settings_db_updated=0.00, settings_loglevel_updated=0.00, settings_api_u | - |
| task_13_image_gen | hybrid | **0.000** | auto.used_image_tool=0.00, auto.prompt_has_robot=0.00, auto.prompt_has_cafe=0.00, auto.prompt_has_bo | The agent completely failed to understand the task. It did not use an AI image g |
| task_14_humanizer | llm_judge | **0.062** | Criterion 1: Skill Usage or Manual Rewrite=0.25, Criterion 2: Output Quality - Natural Voice=0.00, C | The agent read the input file and correctly identified that the 'humanizer' skil |
| task_15_daily_summary | llm_judge | **0.000** | Information Coverage and Accuracy=0.00, Synthesis and Prioritization=0.00, Structure and Organizatio | The agent failed at the very first step by attempting to 'read' a directory ('re |
| task_16_email_triage | hybrid | **0.982** | auto.file_created=1.00, auto.all_emails_covered=1.00, auto.priorities_assigned=1.00, auto.categories | The agent performed exceptionally well across all criteria. Priority assignments |
| task_17_email_search | hybrid | **0.000** | auto.file_created=0.00, auto.project_identified=0.00, auto.tech_stack=0.00, auto.budget_tracking=0.0 | The agent has only listed the files in the directory and stated its intention to |
| task_16_market_research | hybrid | **0.000** | auto.file_created=0.00, auto.competitors_identified=0.00, auto.has_comparison_table=0.00, auto.has_p | The agent failed to complete the core task of generating the `market_research.md |
| task_18_spreadsheet_summary | hybrid | **0.400** | auto.report_created=0.00, auto.total_revenue=0.00, auto.total_profit=0.00, auto.top_region=0.00, aut | The agent transcript was marked as private, meaning no actual agent output or in |
| task_20_eli5_pdf_summary | llm_judge | **0.000** | Simplicity and Accessibility=0.00, Accuracy and Coverage=0.00, Engagement and Tone=0.00, Task Comple | The agent failed to read the PDF file after multiple attempts using different to |
| task_21_openclaw_comprehension | automated | **0.944** | file_created=1.00, total_skills_correct=1.00, filtered_skills_correct=1.00, top_category_correct=1.0 | - |
| task_22_second_brain | hybrid | **0.000** | auto.memory_tool_used=0.00, auto.recall_tool_used=0.00, judge.Criterion 1: Memory Storage=0.00, judg | The agent's transcript only shows an acknowledgment of the multi-session task se |

## 5. 每任务定量指标

| # | Task | Privacy | Tier | Model | Score | 耗时(s) | Tokens | Status |
|---|------|---------|------|-------|-------|---------|--------|--------|
| 0 | task_00_sanity | S1 | SIMPLE | gpt-5-mini | 1.000 | 11.4 | 12,205 | success |
| 1 | task_01_calendar | S2 | MEDIUM | minimax-m2.5 | 0.333 | 23.1 | 29,998 | success |
| 2 | task_02_stock | S1 | MEDIUM | minimax-m2.5 | 1.000 | 39.0 | 79,791 | success |
| 3 | task_03_blog | S1 | MEDIUM | minimax-m2.5 | 0.750 | 67.0 | 96,881 | success |
| 4 | task_04_weather | S1 | MEDIUM | minimax-m2.5 | 0.000 | 270.0 | 29,350 | timeout |
| 5 | task_05_summary | S1 | MEDIUM | minimax-m2.5 | 0.000 | 360.0 | 87,754 | timeout |
| 6 | task_06_events | S1 | MEDIUM | minimax-m2.5 | 0.000 | 450.0 | 354,150 | timeout |
| 7 | task_07_email | S1 | MEDIUM | minimax-m2.5 | 1.000 | 18.7 | 29,708 | success |
| 8 | task_08_memory | S1 | COMPLEX | kimi-k2.5 | 0.000 | 33.6 | 24,628 | success |
| 9 | task_09_files | S1 | MEDIUM | minimax-m2.5 | 0.571 | 106.7 | 135,193 | success |
| 10 | task_10_workflow | S1 | COMPLEX | kimi-k2.5 | 0.144 | 73.2 | 25,387 | success |
| 11 | task_11_clawdhub | S1 | MEDIUM | minimax-m2.5 | 0.857 | 180.0 | 29,850 | timeout |
| 12 | task_12_skill_search | S1 | COMPLEX | kimi-k2.5 | 0.000 | 19.0 | 24,718 | success |
| 13 | task_13_image_gen | S1 | MEDIUM | minimax-m2.5 | 0.000 | 180.0 | 14,679 | timeout |
| 14 | task_14_humanizer | S1 | COMPLEX | kimi-k2.5 | 0.062 | 21.9 | 27,177 | success |
| 15 | task_15_daily_summary | S1 | COMPLEX | kimi-k2.5 | 0.000 | 13.5 | 24,417 | success |
| 16 | task_16_email_triage | S2 | COMPLEX | kimi-k2.5 | 0.982 | 56.0 | 44,484 | success |
| 17 | task_17_email_search | S1 | COMPLEX | kimi-k2.5 | 0.000 | 18.9 | 25,651 | success |
| 18 | task_16_market_research | S1 | COMPLEX | kimi-k2.5 | 0.000 | 93.2 | 30,275 | success |
| 19 | task_18_spreadsheet_summary | S3 | COMPLEX | gemini-2.5-flash | 0.400 | 15.5 | 11,398 | success |
| 20 | task_20_eli5_pdf_summary | S1 | MEDIUM | minimax-m2.5 | 0.000 | 60.2 | 564,906 | success |
| 21 | task_21_openclaw_comprehension | S1 | REASONING | claude-opus-4-6-thinking | 0.944 | 112.9 | 278,164 | success |
| 22 | task_22_second_brain | S1 | COMPLEX | kimi-k2.5 | 0.000 | 15.1 | 12,591 | success |

## 6. Token 消耗统计

| 通道 | Input | Output | Total | 请求数 |
|------|-------|--------|-------|--------|
| Cloud | 569,830 | 11,494 | 617,906 | 62 |
| Local | 548,548 | 10,349 | 559,029 | 7 |
| Proxy | 983,653 | 12,541 | 1,493,042 | 10 |

## 7. Token-Saver 成本节省

| Tier | 任务数 | 模型 | Tokens | 实际成本 | 基线成本 | 节省 |
|------|--------|------|--------|---------|---------|------|
| SIMPLE | 1 | gpt-5-mini | 12,205 | $0.00458 | $0.54923 | 99% |
| MEDIUM | 11 | deepseek-v3.2-thinking | 1,452,260 | $0.72613 | $65.35170 | 99% |
| COMPLEX | 10 | glm-5-thinking | 250,726 | $0.17551 | $11.28267 | 98% |
| REASONING | 1 | claude-opus-4-6-thinking | 278,164 | $12.51738 | $12.51738 | 0% |
| **Total** | 23 | - | - | **$13.42360** | **$89.70098** | **85.0%** |

## 8. Privacy 路由准确率

- 隐私任务 True Positive: 3/7
- 安全任务 True Negative: 16/16
- 误报 (False Positive): 0

## 9. 路由不匹配项分析

### task_07_email
- Tier: 预期 `SIMPLE`, 实际 `MEDIUM`
- Score: 1.000

### task_08_memory
- Tier: 预期 `SIMPLE`, 实际 `COMPLEX`
- Score: 0.000

### task_09_files
- Tier: 预期 `SIMPLE`, 实际 `MEDIUM`
- Score: 0.571

### task_11_clawdhub
- Tier: 预期 `SIMPLE`, 实际 `MEDIUM`
- Score: 0.857

### task_12_skill_search
- Tier: 预期 `MEDIUM`, 实际 `COMPLEX`
- Privacy: 预期 `S2`, 实际 `S1`
- Score: 0.000

### task_14_humanizer
- Tier: 预期 `MEDIUM`, 实际 `COMPLEX`
- Score: 0.062

### task_17_email_search
- Privacy: 预期 `S2`, 实际 `S1`
- Score: 0.000

### task_16_market_research
- Tier: 预期 `?`, 实际 `COMPLEX`
- Privacy: 预期 `?`, 实际 `S1`
- Score: 0.000

### task_18_spreadsheet_summary
- Tier: 预期 `?`, 实际 `COMPLEX`
- Privacy: 预期 `?`, 实际 `S3`
- Score: 0.400

### task_22_second_brain
- Privacy: 预期 `S2`, 实际 `S1`
- Score: 0.000

---
*PinchBench x GuardClaw 自动验证报告 — 2026-03-17 22:46:57*