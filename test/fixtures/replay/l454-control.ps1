# LF-270 回放 L454 的**正对照样本**：包含 L454 的两种缺陷写法（逗号包装 + Add-Member -InputObject）。
# 用途：证明探针不是"永远说抓不到"——对这份样本，探针必须报出 comma_wrap=1 且 addmember_inputobject=1。
function Read-Book([string]$p) { $d = Get-Content $p -Raw | ConvertFrom-Json; return ,@($d.entries) }
foreach ($l in @(Read-Book 'x.json')) { Add-Member -InputObject $l -NotePropertyName _book -NotePropertyValue 'proj' }
