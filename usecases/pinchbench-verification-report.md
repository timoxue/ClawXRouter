# PinchBench x GuardClaw 路由验证 + 跑分报告

> 生成时间: 2026-03-17 20:12:23
> Gateway: `127.0.0.1:18789` | GuardClaw: Privacy Router + Token-Saver Router
> Token-Saver: SIMPLE→gpt-5-mini | MEDIUM→deepseek-v3.2-thinking | COMPLEX→glm-5-thinking | REASONING→claude-opus-4-6-thinking
> PinchBench LLM Judge: gemini-2.5-flash via yeysai.com (直连)
> 评分方法: 官方 PinchBench grading (automated + llm_judge + hybrid)
> 执行模式: sequential with per-task workspace isolation

## 1. 执行摘要

| 指标 | 数值 |
|------|------|
| 总任务数 | 23 |
| Token-Saver 路由正确率 | 14/21 (66%) |
| Privacy 路由正确率 | 18/23 (78%) |
| PinchBench 平均分 | **0.415** / 1.0 |
| PinchBench 总分 | 9.54 / 23.0 |
| 累计耗时 | 2782s |
| 请求错误数 | 0 |

## 2. 隐私路由验证表

| Task | 预期 | 实际 | Match | 理由 |
|------|------|------|-------|------|
| task_00_sanity | S1 | S1 | ✅ | - |
| task_01_calendar | S2 | S2 | ✅ | [privacy:w90] The message explicitly mentions an email addre |
| task_02_stock | S1 | S1 | ✅ | - |
| task_03_blog | S1 | S1 | ✅ | The message requests a blog post about remote work and savin |
| task_04_weather | S1 | S1 | ✅ | - |
| task_05_summary | S1 | S1 | ✅ | - |
| task_06_events | S1 | S1 | ✅ | - |
| task_07_email | S1 | S1 | ✅ | - |
| task_08_memory | S1 | S1 | ✅ | - |
| task_09_files | S1 | S1 | ✅ | - |
| task_10_workflow | S1 | S1 | ✅ | - |
| task_11_clawdhub | S1 | S1 | ✅ | The message requests the creation of a basic Python project  |
| task_12_skill_search | S2 | S1 | ❌ | - |
| task_13_image_gen | S1 | S1 | ✅ | - |
| task_14_humanizer | S1 | S1 | ✅ | - |
| task_15_daily_summary | S1 | S1 | ✅ | - |
| task_16_email_triage | S2 | S2 | ✅ | [privacy:w90] S2 keyword detected: internal |
| task_17_email_search | S2 | S1 | ❌ | - |
| task_16_market_research | ? | S1 | ❌ | - |
| task_18_spreadsheet_summary | ? | S2 | ❌ | [privacy:w90] The 'company_expenses.xlsx' file contains 'emp |
| task_20_eli5_pdf_summary | S1 | S1 | ✅ | - |
| task_21_openclaw_comprehension | S1 | S1 | ✅ | - |
| task_22_second_brain | S2 | S1 | ❌ | - |

## 3. Token-Saver 四级路由验证表

| Task | 预期 Tier | 实际 Tier | Match | model overridden | 耗时(s) |
|------|----------|----------|-------|-----------------|---------|
| task_00_sanity | SIMPLE | SIMPLE | ✅ | `gpt-5-mini` | 10.7 |
| task_01_calendar | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 22.6 |
| task_02_stock | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 270.0 |
| task_03_blog | MEDIUM | - | ❌ | `-` | 76.0 |
| task_04_weather | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 270.0 |
| task_05_summary | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 347.5 |
| task_06_events | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 450.0 |
| task_07_email | SIMPLE | MEDIUM | ❌ | `minimax-m2.5` | 32.0 |
| task_08_memory | SIMPLE | COMPLEX | ❌ | `kimi-k2.5` | 60.3 |
| task_09_files | SIMPLE | MEDIUM | ❌ | `minimax-m2.5` | 180.0 |
| task_10_workflow | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 14.3 |
| task_11_clawdhub | SIMPLE | - | ❌ | `-` | 64.1 |
| task_12_skill_search | MEDIUM | COMPLEX | ❌ | `kimi-k2.5` | 35.5 |
| task_13_image_gen | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 180.0 |
| task_14_humanizer | MEDIUM | COMPLEX | ❌ | `kimi-k2.5` | 26.4 |
| task_15_daily_summary | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 22.6 |
| task_16_email_triage | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 44.5 |
| task_17_email_search | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 15.1 |
| task_16_market_research | ? | COMPLEX | ❌ | `kimi-k2.5` | 55.0 |
| task_18_spreadsheet_summary | ? | COMPLEX | ❌ | `kimi-k2.5` | 27.9 |
| task_20_eli5_pdf_summary | MEDIUM | MEDIUM | ✅ | `minimax-m2.5` | 118.4 |
| task_21_openclaw_comprehension | REASONING | REASONING | ✅ | `claude-opus-4-6-thinking` | 450.0 |
| task_22_second_brain | COMPLEX | COMPLEX | ✅ | `kimi-k2.5` | 8.8 |

## 4. PinchBench 跑分表

| Task | 评分方式 | 分数 | Breakdown | Notes |
|------|---------|------|-----------|-------|
| task_00_sanity | automated | **1.000** | agent_responded=1.00 | - |
| task_01_calendar | automated | **0.833** | file_created=1.00, attendee_present=1.00, title_correct=1.00, description_present=1.00, time_correct | - |
| task_02_stock | automated | **0.000** | file_created=0.00, ticker_present=0.00, price_present=0.00, date_present=0.00, summary_present=0.00, | - |
| task_03_blog | llm_judge | **1.000** | Content Quality and Relevance=1.00, Structure and Organization=1.00, Writing Quality=1.00, Word Coun | Based on the summarized transcript and the absence of any reported issues or age |
| task_04_weather | automated | **1.000** | file_created=1.00, valid_python=1.00, has_http_request=1.00, references_location=1.00, has_error_han | - |
| task_05_summary | llm_judge | **0.988** | Accuracy and Completeness=1.00, Conciseness=1.00, Structure and Coherence=1.00, Writing Quality=1.00 | The agent produced an excellent, accurate, and concise 3-paragraph summary that  |
| task_06_events | llm_judge | **0.000** | criterion_1=0.00, criterion_2=0.00, criterion_3=0.00, criterion_4=0.00, criterion_5=0.00 | The agent failed to complete the task. It encountered an API key error for web_s |
| task_07_email | llm_judge | **0.950** | Professional Tone and Courtesy=1.00, Completeness and Clarity=1.00, Structure and Format=1.00, Conci | The email content is excellent, meeting all requirements for tone, completeness, |
| task_08_memory | automated | **0.000** | file_created=0.00, correct_date=0.00, clear_answer=0.00, read_notes=0.00, no_hallucination=0.00 | - |
| task_09_files | automated | **0.000** | src_directory=0.00, main_py_created=0.00, main_py_valid=0.00, readme_created=0.00, readme_has_title= | - |
| task_10_workflow | hybrid | **0.081** | auto.read_config=0.00, auto.script_created=0.00, auto.valid_syntax=0.00, auto.parses_json=0.00, auto | The agent successfully read the `config.json` file and extracted its content, wh |
| task_11_clawdhub | automated | **0.000** | src_directory_created=0.00, tests_directory_created=0.00, init_file_created=0.00, test_file_created= | - |
| task_12_skill_search | automated | **0.667** | settings_host_updated=1.00, settings_db_updated=1.00, settings_loglevel_updated=1.00, settings_api_u | - |
| task_13_image_gen | hybrid | **0.000** | auto.used_image_tool=0.00, auto.prompt_has_robot=0.00, auto.prompt_has_cafe=0.00, auto.prompt_has_bo | The agent failed to generate an image, craft a prompt, or save the output. It sp |
| task_14_humanizer | llm_judge | **0.150** | Criterion 1: Skill Usage or Manual Rewrite=0.50, Criterion 2: Output Quality - Natural Voice=0.00, C | The agent correctly read the input file, attempted to find the 'humanizer' skill |
| task_15_daily_summary | llm_judge | **0.000** | Information Coverage and Accuracy=0.00, Synthesis and Prioritization=0.00, Structure and Organizatio | The provided agent transcript only shows the initial file discovery step. The ag |
| task_16_email_triage | hybrid | **0.927** | auto.file_created=1.00, auto.all_emails_covered=1.00, auto.priorities_assigned=1.00, auto.categories | The agent demonstrated excellent performance. It correctly identified and priori |
| task_17_email_search | hybrid | **0.000** | auto.file_created=0.00, auto.project_identified=0.00, auto.tech_stack=0.00, auto.budget_tracking=0.0 | The agent only performed the initial file discovery (`ls`) and did not proceed t |
| task_16_market_research | hybrid | **0.969** | auto.file_created=1.00, auto.competitors_identified=0.50, auto.has_comparison_table=1.00, auto.has_p | The agent produced an outstanding competitive landscape analysis. Despite web se |
| task_18_spreadsheet_summary | hybrid | **0.050** | auto.report_created=0.00, auto.total_revenue=0.00, auto.total_profit=0.00, auto.top_region=0.00, aut | The agent successfully read the CSV file. However, it failed to parse the Excel  |
| task_20_eli5_pdf_summary | llm_judge | **0.925** | Simplicity and Accessibility=1.00, Accuracy and Coverage=1.00, Engagement and Tone=1.00, Task Comple | The agent failed to read the specified local PDF file, which was a direct instru |
| task_21_openclaw_comprehension | automated | **0.000** | file_created=0.00, total_skills_correct=0.00, filtered_skills_correct=0.00, top_category_correct=0.0 | - |
| task_22_second_brain | hybrid | **0.000** | auto.memory_tool_used=0.00, auto.recall_tool_used=0.00, judge.Memory Storage=0.00, judge.Same-Sessio | The agent failed to understand the initial task instructions. It interpreted the |

## 5. 每任务定量指标

| # | Task | Privacy | Tier | Model | Score | 耗时(s) | Tokens | Status |
|---|------|---------|------|-------|-------|---------|--------|--------|
| 0 | task_00_sanity | S1 | SIMPLE | gpt-5-mini | 1.000 | 10.7 | 12,087 | success |
| 1 | task_01_calendar | S2 | MEDIUM | minimax-m2.5 | 0.833 | 22.6 | 29,468 | success |
| 2 | task_02_stock | S1 | MEDIUM | minimax-m2.5 | 0.000 | 270.0 | 58,070 | timeout |
| 3 | task_03_blog | S1 | - | - | 1.000 | 76.0 | 11,623 | success |
| 4 | task_04_weather | S1 | MEDIUM | minimax-m2.5 | 1.000 | 270.0 | 145,632 | timeout |
| 5 | task_05_summary | S1 | MEDIUM | minimax-m2.5 | 0.988 | 347.5 | 135,007 | success |
| 6 | task_06_events | S1 | MEDIUM | minimax-m2.5 | 0.000 | 450.0 | 74,000 | timeout |
| 7 | task_07_email | S1 | MEDIUM | minimax-m2.5 | 0.950 | 32.0 | 59,041 | success |
| 8 | task_08_memory | S1 | COMPLEX | kimi-k2.5 | 0.000 | 60.3 | 24,671 | success |
| 9 | task_09_files | S1 | MEDIUM | minimax-m2.5 | 0.000 | 180.0 | 0 | timeout |
| 10 | task_10_workflow | S1 | COMPLEX | kimi-k2.5 | 0.081 | 14.3 | 25,344 | success |
| 11 | task_11_clawdhub | S1 | - | - | 0.000 | 64.1 | 11,129 | success |
| 12 | task_12_skill_search | S1 | COMPLEX | kimi-k2.5 | 0.667 | 35.5 | 50,297 | success |
| 13 | task_13_image_gen | S1 | MEDIUM | minimax-m2.5 | 0.000 | 180.0 | 59,547 | timeout |
| 14 | task_14_humanizer | S1 | COMPLEX | kimi-k2.5 | 0.150 | 26.4 | 40,099 | success |
| 15 | task_15_daily_summary | S1 | COMPLEX | kimi-k2.5 | 0.000 | 22.6 | 24,626 | success |
| 16 | task_16_email_triage | S2 | COMPLEX | kimi-k2.5 | 0.927 | 44.5 | 46,323 | success |
| 17 | task_17_email_search | S1 | COMPLEX | kimi-k2.5 | 0.000 | 15.1 | 25,385 | success |
| 18 | task_16_market_research | S1 | COMPLEX | kimi-k2.5 | 0.969 | 55.0 | 46,718 | success |
| 19 | task_18_spreadsheet_summary | S2 | COMPLEX | kimi-k2.5 | 0.050 | 27.9 | 50,449 | success |
| 20 | task_20_eli5_pdf_summary | S1 | MEDIUM | minimax-m2.5 | 0.925 | 118.4 | 1,125,475 | success |
| 21 | task_21_openclaw_comprehension | S1 | REASONING | claude-opus-4-6-thinking | 0.000 | 450.0 | 69,689 | timeout |
| 22 | task_22_second_brain | S1 | COMPLEX | kimi-k2.5 | 0.000 | 8.8 | 12,308 | success |

## 6. Token 消耗统计

| 通道 | Input | Output | Total | 请求数 |
|------|-------|--------|-------|--------|
| Cloud | 883,651 | 19,273 | 1,851,432 | 59 |
| Local | 43,587 | 2,736 | 46,323 | 1 |
| Proxy | 453,132 | 7,968 | 491,052 | 6 |

## 7. Token-Saver 成本节省

| Tier | 任务数 | 模型 | Tokens | 实际成本 | 基线成本 | 节省 |
|------|--------|------|--------|---------|---------|------|
| SIMPLE | 1 | gpt-5-mini | 12,087 | $0.00453 | $0.54392 | 99% |
| MEDIUM | 9 | deepseek-v3.2-thinking | 1,686,240 | $0.84312 | $75.88080 | 99% |
| COMPLEX | 10 | glm-5-thinking | 346,220 | $0.24235 | $15.57990 | 98% |
| REASONING | 1 | claude-opus-4-6-thinking | 69,689 | $3.13600 | $3.13600 | 0% |
| **Total** | 21 | - | - | **$4.22601** | **$95.14062** | **95.6%** |

## 8. Privacy 路由准确率

- 隐私任务 True Positive: 3/7
- 安全任务 True Negative: 16/16
- 误报 (False Positive): 0

## 9. 路由不匹配项分析

### task_03_blog
- Tier: 预期 `MEDIUM`, 实际 `None`
- Score: 1.000

### task_07_email
- Tier: 预期 `SIMPLE`, 实际 `MEDIUM`
- Score: 0.950

### task_08_memory
- Tier: 预期 `SIMPLE`, 实际 `COMPLEX`
- Score: 0.000

### task_09_files
- Tier: 预期 `SIMPLE`, 实际 `MEDIUM`
- Score: 0.000

### task_11_clawdhub
- Tier: 预期 `SIMPLE`, 实际 `None`
- Score: 0.000

### task_12_skill_search
- Tier: 预期 `MEDIUM`, 实际 `COMPLEX`
- Privacy: 预期 `S2`, 实际 `S1`
- Score: 0.667

### task_14_humanizer
- Tier: 预期 `MEDIUM`, 实际 `COMPLEX`
- Score: 0.150

### task_17_email_search
- Privacy: 预期 `S2`, 实际 `S1`
- Score: 0.000

### task_16_market_research
- Tier: 预期 `?`, 实际 `COMPLEX`
- Privacy: 预期 `?`, 实际 `S1`
- Score: 0.969

### task_18_spreadsheet_summary
- Tier: 预期 `?`, 实际 `COMPLEX`
- Privacy: 预期 `?`, 实际 `S2`
- Score: 0.050

### task_22_second_brain
- Privacy: 预期 `S2`, 实际 `S1`
- Score: 0.000

---
*PinchBench x GuardClaw 自动验证报告 — 2026-03-17 20:12:23*