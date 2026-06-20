export type OriginalTestTask = {
  text: string;
  note: string;
};

export const ORIGINAL_TEST_TASKS: OriginalTestTask[] = [
  { text: "单独说「Loona」", note: "×3 次" },
  { text: "单独说「Hey Loona」", note: "×3 次" },
  { text: "「Loona,今天天气怎么样」", note: "中文·句首 ×3" },
  { text: "「你觉得这件衣服好看吗 Loona」", note: "中文·句尾 ×3" },
  { text: "「我们让 Loona 回答一下这个问题」", note: "中文·句中 ×3" },
  { text: "\"Loona, what is the weather today\"", note: "English·head ×3" },
  { text: "\"Hey Loona, play some music\"", note: "English·head ×3" },
  { text: "\"do you think this looks good Loona\"", note: "English·tail ×3" },
  {
    text: "随意说几句喊 Loona 的话(自由发挥)",
    note: "快说(别刻意到秃噜皮含糊)、慢说(正常点,别太夸张)、远一点说",
  },
  {
    text: "正常打字、说别的话、放音乐",
    note: "别说 Loona!约1分钟。保持本页在最前,一乱醒随手按 Ctrl+Q",
  },
];

export const FINISH_STEPS = [
  "关掉页面，终端里按 Ctrl+C 停止",
  "右键包里的 collected 文件夹 → 压缩",
  "把 collected.zip 发回给我",
];
