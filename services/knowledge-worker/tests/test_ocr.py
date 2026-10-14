from knowledge_worker.ocr import tag_ocr_text


def test_tag_code_and_command():
    tags = tag_ocr_text("$ sudo apt update\n")
    assert "command" in tags


def test_tag_code_block():
    tags = tag_ocr_text("def main():\n    return 1\n")
    assert "code" in tags


def test_tag_slide():
    tags = tag_ocr_text("Module Overview\nLesson objectives\nSummary")
    assert "slide" in tags


def test_tag_plain_text():
    tags = tag_ocr_text("hello")
    assert tags == ["text"]
