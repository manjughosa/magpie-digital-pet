# 现代复古 / HD-2D RPG UI 调研

范围：Sea of Stars、Octopath Traveler II、Unicorn Overlord。以下“事实”只记录所链接截图或官方文字中可见、可读的内容；颜色为视觉描述，不是取色值。Octopath Traveler II 的界面图采用 RPG Site 转载的 Square Enix 发行素材，并在该页明确标注来源。

## 1. Sea of Stars：轻量 HUD，让像素场景占主导

| 维度 | 截图事实 |
|---|---|
| 面板底色 | 对话框是深色半透明圆角底、浅色细边，人物名放在左上方独立小页签；场景仍透过面板可见。[官方对话截图](https://sabotagestudio.com/wp-content/uploads/2022/03/Story-2-launch.png) 战斗状态区直接收在左下角，没有用全宽底板切断场景。[官方战斗截图](https://sabotagestudio.com/wp-content/uploads/2022/03/Combat-1-1.png) |
| 文字层级 | 对话以“人物名页签 → 白色正文 → 右下继续箭头”分层，关键词 `total eclipse` 单独变绿。[官方对话截图](https://sabotagestudio.com/wp-content/uploads/2022/03/Story-2-launch.png) 升级页用金色大号 `LEVEL UP`、白色小号说明，再在底栏排列白色原属性与浅蓝增量。[官方升级截图](https://sabotagestudio.com/wp-content/uploads/2022/03/Combat-2-1.png) |
| accent 使用 | HP 为橙色、MP 为紫色，选中项与标题用金色，属性增量用浅蓝，文本关键词用绿色；颜色分别承担状态、选择、变化和语义强调，而不是整面铺色。[战斗状态](https://sabotagestudio.com/wp-content/uploads/2022/03/Combat-1-1.png) · [升级选择](https://sabotagestudio.com/wp-content/uploads/2022/03/Combat-2-1.png) · [对话](https://sabotagestudio.com/wp-content/uploads/2022/03/Story-2-launch.png) |
| 列表 / 按钮密度 | 战斗主指令围绕当前角色放少量圆形图标，次级属性留在左下三行角色状态中，主操作区没有长列表。[官方战斗截图](https://sabotagestudio.com/wp-content/uploads/2022/03/Combat-6-1.png) 升级奖励一屏横排 4 个大图标，只给当前项显示说明，底部用一行汇总属性。[官方升级截图](https://sabotagestudio.com/wp-content/uploads/2022/03/Combat-2-1.png) |
| 像素画面与 UI | 场景和人物是像素画，UI 同时使用细边、圆角、发光和清晰的小字，并未把所有控件像素化；战斗直接发生在探索场景，没有切到独立战场。[官方战斗截图](https://sabotagestudio.com/wp-content/uploads/2022/03/Combat-1-1.png) · [官方战斗说明](https://seaofstarsgame.co/) 官方 press kit 还明确列出动态光照渲染管线，说明“复古”不等于关闭现代光影。[官方 press kit](https://sabotagestudio.com/presskits/sea-of-stars/) |

## 2. Octopath Traveler II：分区战斗 HUD，精细字体叠在 HD-2D 上

| 维度 | 截图事实 |
|---|---|
| 面板底色 | 战斗指令、回合顺序、角色状态分别落在屏幕边缘的深黑蓝半透明面板上，中央战斗画面保持开放；状态栏用细金边和角色专属色细线分隔。[发行素材：Boost](https://images.rpgsite.net/image/a3ecf1c/118279/original/Octopath-Traveler-II_20220915_37.jpg) |
| 文字层级 | 当前角色名是大号白色衬线字，HP / SP / BP 等是较小的标签，数值更大并按列对齐；敌人盾点、弱点和行动顺序脱离长文本，以图标与数字呈现。[发行素材：Break](https://images.rpgsite.net/image/a3ecf1c/118278/original/Octopath-Traveler-II_20220915_36.jpg) |
| accent 使用 | 金色主要用于边框和古典装饰，橙金色 BP 圆点与选中态承担战斗资源提示，Latent Power 用紫色独立标识；accent 集中在可操作资源，不给正文大面积染色。[发行素材：Boost](https://images.rpgsite.net/image/a3ecf1c/118279/original/Octopath-Traveler-II_20220915_37.jpg) · [发行素材：Latent Power](https://images.rpgsite.net/image/a3ecf1c/118281/original/Octopath-Traveler-II_20220915_39.jpg) |
| 列表 / 按钮密度 | 单个角色只显示一小组纵向战斗指令，四人状态在底部横向并列，敌人信息放在敌人脚下；一屏信息多，但被拆成多个稳定区域，而非一张密集大表。[发行素材：Break](https://images.rpgsite.net/image/a3ecf1c/118278/original/Octopath-Traveler-II_20220915_36.jpg) 技能学习页也是短列表配右侧角色 / 场景，不让列表铺满全屏。[发行素材：Learned Skills](https://images.rpgsite.net/image/a3ecf1c/118266/original/Octopath-Traveler-II_20220915_24.jpg) |
| 像素画面与 UI | 官方将 HD-2D 定义为 retro pixel art 与 3DCG 的融合。[制作人介绍](https://blog.playstation.com/2023/02/23/everything-you-need-to-know-about-octopath-traveler-ii-out-feb-24/) 截图中角色与场景保留像素颗粒，UI 文字、细线和图标则按高分辨率绘制；UI 不模拟低分辨率场景，也不遮住中央演出。[发行素材：战斗全景](https://images.rpgsite.net/image/a3ecf1c/118278/original/Octopath-Traveler-II_20220915_36.jpg) |

素材出处说明：[RPG Site 页面](https://www.rpgsite.net/news/13268-octopath-traveler-ii-details-the-battle-system-hikari-the-warrior-and-agnea-the-dancer)明确写明上述信息与截图由 Square Enix 提供。

## 3. Unicorn Overlord：高密度管理界面，用卡片与网格承载战术复杂度

| 维度 | 截图事实 |
|---|---|
| 面板底色 | 战场 HUD 使用深蓝黑卡片与细金 / 铜色边线，左下为单位卡，顶部集中任务与资源信息；地图仍占大部分画面。[官方战场截图](https://unicornoverlord.atlus.com/media/img/features/ss_01.jpg) 编队页把深色面板划分为角色、装备、属性和操作区，而非单个浮窗。[官方 Tips PDF，第 6 页](https://unicornoverlord.atlus.com/media/pdf/unicorn_overlord_tips_v2.pdf#page=6) |
| 文字层级 | 页面标题、栏目标签、角色名、正文说明和数值使用不同字号 / 字重；属性数字规则分列，技能说明进入独立文本区。[官方 Tips PDF，第 6–7 页](https://unicornoverlord.atlus.com/media/pdf/unicorn_overlord_tips_v2.pdf#page=6) 战场单位卡把角色名、等级、HP 与职业 / 状态压缩在固定卡片内。[官方战场截图](https://unicornoverlord.atlus.com/media/img/features/ss_01.jpg) |
| accent 使用 | 金 / 铜色用于外框、选中轮廓和重要标题，蓝色用于友方信息与选中填充，红 / 橙用于敌对或警示信息；大面积仍是深色中性底。[官方战场截图](https://unicornoverlord.atlus.com/media/img/features/ss_01.jpg) · [官方 Tips PDF，第 6 页](https://unicornoverlord.atlus.com/media/pdf/unicorn_overlord_tips_v2.pdf#page=6) |
| 列表 / 按钮密度 | 编队页同屏呈现多张单位卡、装备槽、数值与操作提示，密度显著高于前两作；复杂度靠网格、对齐和分区管理。[官方 Tips PDF，第 6–7 页](https://unicornoverlord.atlus.com/media/pdf/unicorn_overlord_tips_v2.pdf#page=6) 战场则只保留单位摘要，把详细编成留到管理页。[官方战场截图](https://unicornoverlord.atlus.com/media/img/features/ss_01.jpg) |
| 像素画面与 UI | 本作样本不是像素 HD-2D：战斗人物是高分辨率手绘 2D，UI 同样采用清晰细线与平滑文字，因此无需模拟像素字体。[官方角色 / 战斗截图](https://unicornoverlord.atlus.com/media/img/features/ss_03.jpg) 官方将其描述为 overworld exploration 与 innovative battle system 结合的 tactical fantasy RPG。[官方介绍](https://unicornoverlord.atlus.com/) |

## 4. 设计推导：可直接实施的共同规则

以下是基于上述样本的推导，不是对游戏原作的测量结论。

1. **底色统一，结构分开。** 面板以深蓝黑为默认底，HUD 用约 88–94% 不透明度，管理页用不透明底；只用细金边、间距和分隔线建立层级，避免每个区域换一种底色。
2. **文字只做三级。** 页面 / 角色名为一级，指令与正文为二级，属性标签 / 按键提示为三级。数值右对齐并使用等宽数字；不要用第四种颜色弥补字号层级混乱。
3. **固定 accent 语义。** 金色 = 当前选择 / 主操作，浅蓝 = 增益 / 可确认信息，红色 = 危险 / 敌对，绿色只留作文本关键词或正向状态。单屏以一个主 accent 为主。
4. **按场景选择密度。** 战斗主指令控制在一组 4–6 项；角色管理可显示 6–10 行，但采用“左侧列表 + 右侧详情”，不要同时展开所有技能长说明。复杂数值沿固定网格排列。
5. **像素场景配原生分辨率 UI。** 字体、边框、选中框保持清晰，不对 UI 整体做像素化或 nearest-neighbor 缩放；复古感由金边、图标、短动画和排版承担。
6. **把场景中央留给演出。** 战斗信息贴边、分组、可收起；只有升级、编成等需要专注决策的页面才使用大面积面板。
7. **装饰服从可读性。** 可借用 Sea of Stars 的少量辉光和 Octopath Traveler II 的细金边，但正文不使用发光、像素字体或复杂纹章底。

### 起始 UI tokens（推导值，非截图取色）

```css
:root {
  --panel: #111923;
  --panel-solid: #151e29;
  --border: #9b8152;
  --text: #f2eee4;
  --text-muted: #a6afba;
  --accent-focus: #e5b75c;
  --accent-positive: #72c7d4;
  --accent-danger: #d86b62;
}
```

**最小落地顺序：**先统一 panel / text / focus tokens，再重排战斗 HUD 与管理页网格，最后加细边和短暂选中辉光；不要从像素字体或大面积装饰开始。
