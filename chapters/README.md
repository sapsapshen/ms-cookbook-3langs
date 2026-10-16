# 章节源文件已迁移

当前 Markdown 阅读版位于 [content/chapters](../content/chapters/)，构建源文件位于 [content/source-html](../content/source-html/)，编辑说明见 [content/README.md](../content/README.md)。旧版本保留在 Git 历史中。

兼容命令：

```sh
node scripts/build-content.mjs
node scripts/build-content.mjs --check
```

以上命令使用 Python 3 构建 `content/` 中的稿件。
