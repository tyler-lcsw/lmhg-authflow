import re

def process_html():
    with open('views/form_template.ejs', 'r') as f:
        html = f.read()

    # Process text/date/tel inputs
    def text_handler(m):
        full_tag = m.group(0)
        name_match = re.search(r'name="([^"]+)"', full_tag)
        if name_match and 'value=' not in full_tag:
            name = name_match.group(1)
            # Insert the value attribute before the closing '>'
            return full_tag[:-1] + f' value="<%= data.{name} || \'\' %>">'
        elif name_match and 'value=' in full_tag:
            # what if value="" is there? We won't worry, the template doesn't have it.
            pass
        return full_tag
    
    html = re.sub(r'<input[^>]+type="(?:text|date|tel|email)"[^>]*>', text_handler, html)
    
    # Process text inputs without type (default)
    def text_no_type_handler(m):
        full_tag = m.group(0)
        if 'type=' not in full_tag:
            name_match = re.search(r'name="([^"]+)"', full_tag)
            if name_match and 'value=' not in full_tag:
                name = name_match.group(1)
                return full_tag[:-1] + f' value="<%= data.{name} || \'\' %>">'
        return full_tag
    
    html = re.sub(r'<input[^>]*>', text_no_type_handler, html)

    # Process radio inputs
    def radio_handler(m):
        full_tag = m.group(0)
        name_match = re.search(r'name="([^"]+)"', full_tag)
        val_match = re.search(r'value="([^"]+)"', full_tag)
        if name_match and val_match and '<%=' not in full_tag:
            name = name_match.group(1)
            val = val_match.group(1)
            return full_tag[:-1] + f' <%= data.{name} === \'{val}\' ? \'checked\' : \'\' %>>'
        return full_tag
    
    html = re.sub(r'<input[^>]+type="radio"[^>]*>', radio_handler, html)
    
    # Process checkbox inputs representing arrays or booleans
    # It's safer to just do a string includes check for checkboxes
    def checkbox_handler(m):
        full_tag = m.group(0)
        name_match = re.search(r'name="([^"]+)"', full_tag)
        val_match = re.search(r'value="([^"]+)"', full_tag)
        if name_match and val_match and '<%=' not in full_tag:
            name = name_match.group(1)
            val = val_match.group(1)
            # using data.name && data.name.includes('val') for checkbox
            # or if it's a single value, data.name === val. Let's cover both.
            cond = f"(Array.isArray(data.{name}) ? data.{name}.includes('{val}') : data.{name} === '{val}')"
            return full_tag[:-1] + f' <%= {cond} ? \'checked\' : \'\' %>>'
        return full_tag
    
    html = re.sub(r'<input[^>]+type="checkbox"[^>]*>', checkbox_handler, html)

    # Process textareas
    def textarea_handler(m):
        full_tag_open = m.group(1)
        inner_content = m.group(2)
        full_tag_close = m.group(3)
        name_match = re.search(r'name="([^"]+)"', full_tag_open)
        if name_match:
            name = name_match.group(1)
            return f'{full_tag_open}<%= data.{name} || \'\' %>{full_tag_close}'
        return m.group(0)
        
    html = re.sub(r'(<textarea[^>]*>)(.*?)(</textarea>)', textarea_handler, html, flags=re.DOTALL)

    # Hide print button since backend renders it
    html = html.replace('onclick="window.print()"', 'style="display:none;"')

    with open('views/form_template.ejs', 'w') as f:
        f.write(html)
        
    print("EJS conversion complete.")

if __name__ == '__main__':
    process_html()
