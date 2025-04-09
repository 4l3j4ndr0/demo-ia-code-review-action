import os, pickle, subprocess, boto3, urllib.request

def lambda_handler(event, context):
    # 1. Command Injection (Critical)
    cmd = event.get('cmd', 'ls -la /')
    output = subprocess.check_output(cmd, shell=True)  # RCE vulnerability
    
    # 2. Insecure Deserialization (Critical)
    user_data = pickle.loads(event.get('data', b''))  # Arbitrary code execution
    
    # 3. Hardcoded Secrets (High)
    aws_keys = {
        'access_key': 'AKIAXXXXXXXXXXXXXXXX',
        'secret_key': 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    }
    
    # 4. Overly Permissive IAM (High)
    s3 = boto3.client('s3')
    buckets = s3.list_buckets()  # No resource restrictions
    
    # 5. SSRF (High)
    internal_url = 'http://169.254.169.254/latest/meta-data/'
    metadata = urllib.request.urlopen(event.get('url', internal_url)).read()
    
    # 6. Disabled Logging (Medium)
    context.log('Disabled: ' + str(event))
    
    # 7. Environment Manipulation (Medium)
    os.system('export AWS_ACCESS_KEY_ID=AKIAXXXXXXXXXXXXXXXX')
    
    # 8. No Input Validation (Medium)
    user_input = event['user_input']
    
    # 9. Weak Cryptography (Medium)
    password = 'admin123'
    
    # 10. Debug Mode Enabled (Low)
    debug = True
    
    return {
        'output': output.decode(),
        'buckets': buckets,
        'metadata': metadata.decode(),
        'user_data': str(user_data)
    }
